export async function getApiStatus() {
  const response = await fetch("/api/status");
  if (!response.ok) throw new Error("无法连接本地服务");
  return response.json();
}

export async function getPublishedManifest(sha256 = "") {
  const endpoint = sha256 ? `/api/pages-manifest?sha256=${encodeURIComponent(sha256)}` : "/api/pages-manifest";
  const response = await fetch(endpoint, { cache: "no-store" });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "无法读取已发布的双语内容");
  return data;
}

export async function getPublishedCatalog() {
  const response = await fetch("/api/pages-catalog", { cache: "no-store" });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "无法读取已发布的书架目录");
  return data;
}

export async function reportPublishedSync(summary) {
  const response = await fetch("/api/pages-sync-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(summary),
  });
  if (!response.ok) throw new Error("本地同步结果确认失败");
}

export async function saveModelConfig(model, apiKey, options = {}) {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, apiKey, ...options }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "模型配置保存失败");
  return data;
}

export async function mixParagraphBatch(paragraphs, settings) {
  const response = await fetch("/api/mix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paragraphs, ...settings }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `API 请求失败（${response.status}）`);
    error.retryable = data.retryable === true;
    error.retryAfterMs = Number(data.retryAfterMs) || 0;
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

export async function exportPagesReader(file, manifest) {
  const bookResponse = await fetch("/api/pages-export/book", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Book-Name": encodeURIComponent(file.name),
      "X-Book-Type": file.type || "application/octet-stream",
      "X-Book-Modified": String(file.lastModified || 0),
    },
    body: file,
  });
  const bookResult = await bookResponse.json().catch(() => ({}));
  if (!bookResponse.ok) throw new Error(bookResult.error || "原书导出失败");

  const manifestResponse = await fetch("/api/pages-export/manifest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...manifest, uploadToken: bookResult.uploadToken }),
  });
  const result = await manifestResponse.json().catch(() => ({}));
  if (!manifestResponse.ok) throw new Error(result.error || "GitHub Pages 阅读版构建失败");
  return result;
}
