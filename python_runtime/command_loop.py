"""stdin command loop — reads control commands from Node-RED.

Runs in a dedicated thread. Each line is parsed as JSON and dispatched
to the registered command handlers. Results are sent back via the
output queue as command_result events.
"""

import logging
import sys
import threading
from typing import Any, Callable, Dict, Optional, Set

from python_runtime.protocol import decode_command, make_command_result

logger = logging.getLogger(__name__)

# Supported commands
VALID_COMMANDS: Set[str] = {
    "start", "stop", "restart", "health",
    "pause_source", "resume_source", "screenshot",
}

# Type alias for command handler
CommandHandler = Callable[[str, str, Dict[str, Any]], Dict[str, Any]]
# handler(command, request_id, params) -> result_dict or raises


class CommandLoop:
    """Reads control commands from stdin in a background thread.

    Each line is parsed, validated, and dispatched to registered handlers.
    Responses are put onto the output queue as command_result events.
    """

    def __init__(
        self,
        output_queue,
        session_id: str,
        get_next_seq,
        on_eof: Optional[Callable[[], None]] = None,
    ):
        self._output_queue = output_queue
        self._session_id = session_id
        self._get_next_seq = get_next_seq
        self._on_eof = on_eof
        self._handlers: Dict[str, CommandHandler] = {}
        self._running = False
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Handler registration
    # ------------------------------------------------------------------

    def register(self, command: str, handler: CommandHandler) -> None:
        """Register a handler for a control command."""
        self._handlers[command] = handler

    def set_session_id(self, session_id: str) -> None:
        """Update the session used by future command_result events."""
        self._session_id = session_id

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    def _dispatch(self, cmd: str, request_id: str, params: Dict[str, Any]) -> None:
        """Dispatch a command and enqueue the result."""
        handler = self._handlers.get(cmd)
        try:
            if cmd not in VALID_COMMANDS:
                raise ValueError(f"Unknown command: {cmd}")
            if handler is None:
                raise ValueError(f"No handler registered for command: {cmd}")
            result = handler(cmd, request_id, params)
            self._send_result(request_id, cmd, ok=True, result=result)
        except Exception as exc:
            logger.exception("Command %s failed", cmd)
            self._send_result(request_id, cmd, ok=False, error=str(exc))

    def _send_result(
        self,
        request_id: str,
        command: str,
        ok: bool,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> None:
        """Enqueue a command_result event."""
        event = make_command_result(
            request_id=request_id,
            command=command,
            ok=ok,
            result=result,
            error=error,
            session_id=self._session_id,
            event_seq=self._get_next_seq(),
        )
        self._output_queue.put(event)

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the command loop in a background thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="cmd-loop")
        self._thread.start()
        logger.info("Command loop started")

    def stop(self) -> None:
        """Signal the command loop to stop."""
        self._running = False
        # Closing stdin will cause readline() to return empty, exiting the loop

    def join(self, timeout: float = 5.0) -> None:
        """Wait for the command loop thread to exit."""
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def _run(self) -> None:
        """Read stdin line by line, parse JSON, and dispatch commands."""
        logger.info("Command loop running, waiting for stdin commands")
        while self._running:
            try:
                line = sys.stdin.readline()
                if not line:
                    # EOF — stdin closed, treat as stop signal
                    logger.info("stdin closed, stopping command loop")
                    self._running = False
                    if self._on_eof:
                        self._on_eof()
                    break

                line = line.strip()
                if not line:
                    continue  # skip empty lines

                try:
                    cmd_obj = decode_command(line)
                except ValueError as exc:
                    logger.warning("Invalid command line: %s", exc)
                    # Can't send command_result without request_id — log only
                    continue

                cmd = cmd_obj["command"]
                request_id = cmd_obj["request_id"]
                params = cmd_obj.get("params", {})

                logger.debug("Received command: %s (req=%s)", cmd, request_id)
                self._dispatch(cmd, request_id, params)

            except Exception:
                logger.exception("Unhandled error in command loop")
        logger.info("Command loop exited")
