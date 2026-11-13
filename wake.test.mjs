import assert from "node:assert/strict";
import dgram from "node:dgram";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import extension, { buildMagicPacket, sendMagicPacket } from "./index.ts";

test("real UDP send and selection/turn wake race", async () => {
	const receiver = dgram.createSocket("udp4");
	receiver.bind(0, "127.0.0.1");
	await once(receiver, "listening");
	const originalCreateSocket = dgram.createSocket;
	let sends = 0;
	// Keep real socket binding and broadcast setup, but deliver to a local receiver.
	dgram.createSocket = (...args) => {
		const socket = originalCreateSocket(...args);
		const send = socket.send.bind(socket);
		socket.send = (packet, port, host, callback) => {
			assert.equal(port, 9);
			assert.equal(host, "255.255.255.255");
			sends++;
			return send(packet, receiver.address().port, "127.0.0.1", callback);
		};
		return socket;
	};
	const oldUrl = process.env.LLAMA_BASE_URL;
	const oldMac = process.env.LLAMA_WAKE_MAC;
	const server = http.createServer((_req, res) => res.end('{"data":[]}'));
	try {
		const packet = buildMagicPacket("02:00:00:00:00:01");
		const received = once(receiver, "message");
		await sendMagicPacket(packet);
		assert.deepEqual((await received)[0], packet);

		// Reserve a port, then close it to simulate a sleeping server.
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = server.address().port;
		await new Promise((resolve) => server.close(resolve));
		process.env.LLAMA_BASE_URL = `http://127.0.0.1:${port}/v1`;
		process.env.LLAMA_WAKE_MAC = "02:00:00:00:00:01";
		const handlers = {};
		await extension({
			registerCommand() {},
			registerProvider() {},
			on(name, handler) {
				handlers[name] = handler;
			},
		});
		const model = { provider: "llama-cpp", id: "test" };
		const ctx = { model, ui: { notify() {} } };
		const wakePacket = once(receiver, "message");
		handlers.model_select({ model }, ctx);
		let turnFinished = false;
		const turn = handlers.before_agent_start({}, ctx).then(() => {
			turnFinished = true;
		});
		await wakePacket;
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(turnFinished, false, "turn must wait for selection's wake attempt");
		server.listen(port, "127.0.0.1");
		await once(server, "listening");
		await turn;
		assert.equal(sends, 2, "one direct test send plus one shared wake send");
	} finally {
		dgram.createSocket = originalCreateSocket;
		if (oldUrl === undefined) delete process.env.LLAMA_BASE_URL;
		else process.env.LLAMA_BASE_URL = oldUrl;
		if (oldMac === undefined) delete process.env.LLAMA_WAKE_MAC;
		else process.env.LLAMA_WAKE_MAC = oldMac;
		receiver.close();
		server.close();
	}
});
