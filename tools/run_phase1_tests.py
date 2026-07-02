"""Run all Phase 1 Python and Node.js tests with one command."""

from pathlib import Path
import subprocess
import sys


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        cwd=str(root),
        check=True,
    )
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    subprocess.run(
        [npm, "test"],
        cwd=str(root / "node-red-contrib-aiban-workflow"),
        check=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
