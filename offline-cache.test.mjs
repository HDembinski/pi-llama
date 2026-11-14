import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import extension from "./index.ts";

const CACHE_FILE = "llama-cpp-models.json";

async function waitForCache(file, pred, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const data = JSON.parse(fs.readFileSync(file, "utf8"));
			if (pred(data)) {
				return data;
			}
		} catch {
			// not written (or mid-rename) yet
		}
		if (Date.now() > deadline) {
			throw new Error("cache did not update in time");
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test("offline cache keeps the provider visible with the last-seen context size", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-llama-cache-"));
	const cacheFile = path.join(agentDir, CACHE_FILE);
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldUrl = process.env.LLAMA_BASE_URL;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const server = http.createServer((req, res) => {
		if (req.url === "/v1/models") {
			res.end(
				JSON.stringify({
					data: [
						{
							id: "m1",
							aliases: ["M1"],
							status: { value: "unloaded" },
							meta: { n_ctx: 4096 },
						},
					],
				}),
			);
		} else if (req.url?.startsWith("/props")) {
			res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }));
		} else {
			res.statusCode = 404;
			res.end();
		}
	});
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		process.env.LLAMA_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;

		const registrations = [];
		const handlers = {};
		await extension({
			registerCommand(name, def) {
				handlers[name] = def;
			},
			registerProvider(_id, config) {
				registrations.push(config);
			},
			on(name, handler) {
				handlers[name] = handler;
			},
		});

		// Live catalog lands and the cache is written with the /v1/models n_ctx.
		const live = registrations.at(-1).models;
		assert.equal(live.length, 1);
		assert.equal(live[0].contextWindow, 4096);
		const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		assert.equal(cached[0].id, "m1");
		assert.equal(cached[0].contextWindow, 4096);

		// Selecting the model learns the /props context size into the cache.
		const model = { provider: "llama-cpp", id: "m1" };
		handlers.model_select(
			{ model },
			{ model, ui: { notify() {}, setWidget() {}, theme: { fg: (_t, s) => s } } },
		);
		const updated = await waitForCache(cacheFile, (data) => data[0].contextWindow === 8192);
		assert.equal(updated[0].maxTokens, 8192);

		// Server dies: the refresh falls back to the cached models, marked
		// offline, keeping the learned context size.
		await new Promise((resolve) => server.close(resolve));
		let notified = null;
		await handlers["llama-refresh"].handler("", {
			ui: {
				notify(message, type) {
					notified = [message, type];
				},
			},
		});
		const offline = registrations.at(-1).models;
		assert.equal(offline.length, 1);
		assert.equal(offline[0].name, "M1 (offline)");
		assert.equal(offline[0].contextWindow, 8192);
		// The marker keeps the pi-web catalog re-request prefix.
		assert.ok(notified[0].startsWith("llama.cpp catalog"));
		assert.equal(notified[1], "warning");

		// A fresh boot with the server still down serves the cached catalog
		// (the original "provider disappears" case).
		const registrations2 = [];
		const handlers2 = {};
		await extension({
			registerCommand(name, def) {
				handlers2[name] = def;
			},
			registerProvider(_id, config) {
				registrations2.push(config);
			},
			on(name, handler) {
				handlers2[name] = handler;
			},
		});
		const boot = registrations2.at(-1).models;
		assert.equal(boot.length, 1);
		assert.equal(boot[0].name, "M1 (offline)");
		assert.equal(boot[0].contextWindow, 8192);
	} finally {
		if (oldAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
		if (oldUrl === undefined) {
			delete process.env.LLAMA_BASE_URL;
		} else {
			process.env.LLAMA_BASE_URL = oldUrl;
		}
		server.close();
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
