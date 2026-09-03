export function apiError(message, status = 400, code = "", retryAfterMs = 0) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  const quotaExhausted = /insufficient[_ .-]?(quota|balance)|arrearage|free.?quota.*exhaust|payment|quota[_ .-]?exhaust|额度.*用尽|余额不足/i.test(`${code} ${message}`);
  error.retryable = status === 429 && !quotaExhausted;
  error.retryAfterMs = retryAfterMs;
  return error;
}

export function publicApiError(error) {
  return { error: error.name === "AbortError" ? "API 请求超时；已保存的段落可继续使用" : error.message,
    code: error.code || "REQUEST_FAILED", retryable: Boolean(error.retryable), retryAfterMs: error.retryAfterMs || 0 };
}

export async function readCompletionStream(body) {
  if (!body) throw apiError("模型返回了空流");
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let ended = false;
  function line(raw) {
    if (!raw.startsWith("data:")) return;
    const value = raw.slice(5).trim();
    if (!value) return;
    if (value === "[DONE]") { ended = true; return; }
    const chunk = JSON.parse(value);
    if (chunk.error) throw apiError(chunk.error.message || "模型流式响应失败", 400, chunk.error.code);
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason === "length") throw apiError("模型输出达到长度上限，本批未完成；可关闭思考后重试", 400, "OUTPUT_TRUNCATED");
    if (choice?.finish_reason && choice.finish_reason !== "stop") throw apiError("模型未正常完成本批输出", 400, "OUTPUT_INCOMPLETE");
    if (typeof choice?.delta?.content === "string") content += choice.delta.content;
    if (choice?.finish_reason === "stop") ended = true;
    if (content.length > 2_000_000) throw apiError("模型返回内容过大");
  }
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      line(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
    }
    if (buffer.length > 2_000_000) throw apiError("模型流式数据过大");
  }
  buffer += decoder.decode();
  if (buffer.trim()) line(buffer.trim());
  if (!ended || !content.trim()) throw apiError("模型流式输出中断或没有最终回答，本批未标记完成", 400, "OUTPUT_INCOMPLETE");
  return content;
}

export async function qwenRequest(baseUrl, profile, body, timeoutMs = 300000) {
  if (!profile.apiKey) throw apiError("所选模型尚未配置 API Key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${profile.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const retryHeader = response.headers.get("retry-after");
      const seconds = Number(retryHeader);
      const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryHeader) - Date.now()) || 0;
      throw apiError(`千问 API：${data?.error?.message || data?.message || `HTTP ${response.status}`}`,
        response.status, data?.error?.code || data?.code || "", retryAfterMs);
    }
    if (response.headers.get("content-type")?.includes("text/event-stream")) return await readCompletionStream(response.body);
    const data = await response.json();
    const choice = data?.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== "stop") throw apiError("模型输出未正常完成，本批未标记完成", 400, "OUTPUT_INCOMPLETE");
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw apiError("模型返回内容为空");
    return content;
  } finally { clearTimeout(timer); }
}
