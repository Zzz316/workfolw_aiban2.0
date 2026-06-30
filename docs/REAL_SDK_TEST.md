# Real AiBan SDK Test in VSCode

## Required processes

1. Node-RED with `aiban-frame-input -> debug` deployed.
2. Either `main.py` or the isolated SDK diagnostic runner.

Restart Node-RED after updating custom node source. Deploying a flow does not
reload JavaScript already loaded by the Node-RED process.

## Option A: run the full system

Open `main.py` in VSCode and choose **Run Python File**. With no arguments it
uses:

```text
SDK home:       D:/product/AiBanWorkSpace
user config:    D:/product/AiBanWorkSpace/config.ini
pipeline YAML:  D:/product/AiBanWorkSpace/abvideo/main-flow.yaml
Node endpoint:  tcp://127.0.0.1:5557
```

The V2 bridge and legacy shadow engine are enabled by default. Command-line
overrides:

```powershell
python main.py `
  --sdk-home D:/product/AiBanWorkSpace `
  --pipeline-config D:/product/AiBanWorkSpace/abvideo/main-flow.yaml `
  --latency-log-every 1
```

Use `--no-legacy-engine` after shadow comparison is complete.

## Option B: isolated real SDK diagnostic

This does not start Flask, alarm processing, MySQL or the legacy workflow:

```powershell
python tools/test_aiban_sdk_bridge.py --print-every 1
```

It prints:

```text
[SDK回调] ... 转换并入队=1.234ms
[FrameBridge延迟] ... ACK往返=2.345ms 总投递=5.678ms
```

## Node-RED timing output

Enable **显示耗时** in the `aiban-frame-input` node and set **每 N 帧记录**.
The node status shows the latest and average Python-to-Node latency. Debug
messages contain:

```text
msg.payload._timing.sdk_convert_ms
msg.payload._timing.python_to_node_ms
msg.payload._timing.wire_ms
msg.payload._timing.node_inbox_persist_ms
```

Interpretation:

- `sdk_convert_ms`: SDK metadata converted to pure values.
- `python_to_node_ms`: callback conversion start through Node receive.
- `wire_ms`: ZeroMQ send through Node receive.
- `node_inbox_persist_ms`: validation and durable inbox insert.
- Python `ACK往返`: send through durable Node ACK returned to Python.
