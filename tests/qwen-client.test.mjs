import test from "node:test";
import assert from "node:assert/strict";
import { readCompletionStream, apiError } from "../qwen-client.mjs";
import { thinkingRequestOptions, normalizeConcurrency } from "../src/request-settings.js";

async function* bytes(text) {
  const all = new TextEncoder().encode(text);
  for (let index = 0; index < all.length; index += 3) yield all.slice(index, index + 3);
}

test("thinking switches use true/false or omit parameter, and streaming avoids JSON mode conflict", () => {
  assert.deepEqual(thinkingRequestOptions("disabled"), { enable_thinking: false, response_format: { type: "json_object" } });
  assert.equal(thinkingRequestOptions("enabled").thinking_budget, 8192);
  assert.deepEqual(thinkingRequestOptions("default"), { enable_thinking: false, response_format: { type: "json_object" } });
  assert.throws(() => thinkingRequestOptions("bad"));
  assert.throws(() => normalizeConcurrency(7));
});

test("Qwen thinking strengths use distinct budgets with room for the final JSON", () => {
  for (const [mode, budget] of Object.entries({ low: 1024, medium: 4096, high: 8192, max: 16384 })) {
    const options = thinkingRequestOptions(mode, "qwen-flash");
    assert.equal(options.thinking_budget, budget);
    assert.equal(options.max_completion_tokens, budget + 12000);
    assert.equal(options.enable_thinking, true);
    assert.equal(options.response_format, undefined);
  }
});

test("DeepSeek strength uses native effort and rejects aliased unsupported tiers", () => {
  assert.equal(thinkingRequestOptions("high", "deepseek-v4-flash").reasoning_effort, "high");
  assert.equal(thinkingRequestOptions("max", "deepseek-v4-flash").reasoning_effort, "max");
  assert.throws(() => thinkingRequestOptions("low", "deepseek-v4-flash"), /不支持/);
  assert.throws(() => thinkingRequestOptions("medium", "deepseek-v4-flash"), /不支持/);
  assert.equal(thinkingRequestOptions("low", "deepseek-v4-flash-0731").reasoning_effort, "low");
});

test("stream parser handles chunk boundaries and UTF-8, and only returns final content", async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: "不能出现在结果中的思考" } }] },
    { choices: [{ delta: { content: '{"内容":' } }] },
    { choices: [{ delta: { content: '"结果"}' }, finish_reason: "stop" }] },
  ];
  const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  assert.equal(await readCompletionStream(bytes(text)), '{"内容":"结果"}');
});

test("truncated and broken streams fail instead of caching incomplete output", async () => {
  await assert.rejects(() => readCompletionStream(bytes('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')), /中断/);
  await assert.rejects(() => readCompletionStream(bytes('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n')), /长度上限/);
});

test("TPM 429 is retryable but exhausted balance and authentication failures are not", () => {
  assert.equal(apiError("Allocated quota exceeded", 429, "Throttling").retryable, true);
  assert.equal(apiError("quota spent", 429, "insufficient_quota").retryable, false);
  assert.equal(apiError("Balance unpaid", 403, "Arrearage").retryable, false);
  assert.equal(apiError("Bad key", 401).retryable, false);
});
