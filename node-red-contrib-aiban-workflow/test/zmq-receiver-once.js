"use strict";

const { Router } = require("zeromq");
const protocol = require("../lib/frame-protocol");
const { FrameInbox } = require("../lib/frame-inbox");

async function main() {
    const endpoint = process.argv[2];
    const filename = process.argv[3];
    const socket = new Router();
    socket.linger = 0;
    const inbox = new FrameInbox(filename);
    await socket.bind(endpoint);
    process.stdout.write("READY\n");

    for await (const parts of socket) {
        const identity = parts[0];
        const envelope = JSON.parse(parts[parts.length - 1].toString("utf8"));
        const frame = protocol.unpackEnvelope(envelope);
        inbox.persist(frame);
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
