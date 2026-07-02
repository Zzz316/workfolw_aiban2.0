"use strict";

const { Router } = require("zeromq");
const protocol = require("../lib/frame-protocol");
const { FrameInbox } = require("../lib/frame-inbox");

async function main() {
    const endpoint = process.argv[2];
    const filename = process.argv[3];
    const ackAfter = Math.max(1, Number(process.argv[4] || 1));
    const socket = new Router();
    socket.linger = 0;
    const inbox = new FrameInbox(filename);
    await socket.bind(endpoint);
    process.stdout.write("READY\n");

    let receiveCount = 0;
    for await (const parts of socket) {
        const identity = parts[0];
        const envelope = JSON.parse(parts[parts.length - 1].toString("utf8"));
        const frame = protocol.unpackEnvelope(envelope).frame;
        inbox.persist(frame);
        receiveCount += 1;
        process.stdout.write(`RECEIVED ${receiveCount} ${frame.message_id}\n`);
        if (receiveCount < ackAfter) continue;
        await socket.send([
            identity,
            Buffer.from(JSON.stringify(protocol.makeAck(frame)), "utf8"),
        ]);
        process.stdout.write(`ACKED ${frame.message_id}\n`);
        break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.close();
    inbox.close();
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
