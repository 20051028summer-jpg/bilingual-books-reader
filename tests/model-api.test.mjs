import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

test("local API saves/selects models, restarts, and uses the requested model/key upstream", { timeout: 30000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const directory = fs.mkdtempSync(path.join(root, ".model-api-test-"));
  let child;
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    let text = "";
    for await (const part of request) text += part;
    requests.push({ body: JSON.parse(text), authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    const input = JSON.parse(text);
    const user = JSON.parse(input.messages[1].content);
    const content = JSON.stringify({ paragraphs: user.paragraphs.map((p) => ({ id: p.id, replacements: [] })) });
    if (input.stream) {
      response.setHeader("Content-Type", "text/event-stream");
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "test reasoning" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    } else response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit");
      child.kill();
      await closed;
    }
  }
  t.after(async () => {
    await stop();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const name of ["server.mjs", "model-profiles.mjs", "qwen-client.mjs", "pages-export.mjs", "package.json", "src", "prompts"]) {
    fs.cpSync(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  fs.mkdirSync(path.join(directory, "dist"));
  fs.writeFileSync(path.join(directory, "dist", "index.html"), "test fixture");
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  async function start() {
    child = spawn(process.execPath, [path.join(directory, "server.mjs"), "--production"], {
      cwd: directory, windowsHide: true, stdio: "ignore",
      env: { ...process.env, PORT: String(port), MODEL: "qwen-flash", DASHSCOPE_API_KEY: "sk-fixture-a",
        DASHSCOPE_BASE_URL: `http://127.0.0.1:${upstream.address().port}` },
    });
    let startError;
    child.on("error", (error) => { startError = error; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error("Test server exited before readiness");
      try {
        const result = await fetch(`${url}/api/status`);
        if (result.ok) return result.json();
      } catch { /* server is starting */ }
      await delay(50);
    }
    throw new Error("Local test server did not start");
  }
  async function config(body, expectedStatus = 200) {
    const response = await fetch(`${url}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, expectedStatus);
    const result = await response.json();
    assert.ok(!JSON.stringify(result).includes("sk-fixture"));
    return result;
  }
  assert.equal((await start()).model, "qwen-flash");
  assert.equal((await config({ model: "test-model-b", apiKey: "sk-fixture-b", thinking: "enabled", concurrency: 4 })).model, "test-model-b");
  await stop();
  const restarted = await start();
  assert.equal(restarted.model, "test-model-b");
  assert.equal(restarted.thinking, "high");
  assert.equal(restarted.concurrency, 4);
  assert.equal((await config({ model: "qwen-flash" })).model, "qwen-flash");
  await config({ model: "unknown-model" }, 400);
  // A remains active; an already-running tab explicitly requests B for its chapter.
  const response = await fetch(`${url}/api/mix`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-model-b", paragraphs: [{ id: 0, text: "今天她拿起书本，打开窗户，看着窗外的树木。" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "test-model-b");
  assert.ok(requests.length >= 1);
  for (const request of requests) {
    assert.equal(request.body.model, "test-model-b");
    assert.equal(request.authorization, "Bearer sk-fixture-b");
    assert.equal(request.body.enable_thinking, true);
    assert.equal(request.body.reasoning_effort, "high");
    assert.equal(request.body.stream, true);
    assert.equal(request.body.response_format, undefined);
  }
  assert.equal((await (await fetch(`${url}/api/status`)).json()).model, "qwen-flash");
});
