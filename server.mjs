import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { createServer as createViteServer } from "vite";
import { MIX_ANALYZER_SYSTEM_PROMPT, PROMPT_VERSION, buildAnalyzerUserPrompt } from "./prompts/system-prompts.mjs";
import {
  buildMixDiagnostics,
  buildParagraphPlan,
  countReplacementSourceCharacters,
} from "./src/mix-planning.js";
import { normalizeDensity, normalizeLevel } from "./src/settings.js";
import { validateReplacements } from "./src/validator.js";
import { createModelProfiles } from "./model-profiles.mjs";
import { normalizeThinking, thinkingRequestOptions } from "./src/request-settings.js";
import { qwenRequest, publicApiError } from "./qwen-client.mjs";
import {
  findStagedBook,
  publishStagedPagesBook,
  sanitizePagesManifest,
  stagePagesBook,
} from "./pages-export.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(root, ".env.local") });
dotenv.config({ path: path.join(root, ".env") });
const isProduction = process.argv.includes("--production");
const port = Number(process.env.PORT || 4317);
const baseUrl = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
const modelProfiles = createModelProfiles(path.join(root, ".model-profiles.local.json"), {
  model: process.env.MODEL || "qwen-flash",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const app = express();
const execFileAsync = promisify(execFile);
let pagesExportInProgress = false;

app.post("/api/pages-export/book", express.raw({ type: "application/octet-stream", limit: "100mb" }), (request, response) => {
  try {
    const staged = stagePagesBook(root, request.body, request.headers);
    response.json({ uploadToken: staged.token, bytes: staged.bytes, sha256: staged.sha256 });
  } catch (error) {
    console.error(`[pages-export] ${error.message}`);
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/pages-export/manifest", express.json({ limit: "50mb" }), async (request, response) => {
  if (pagesExportInProgress) {
    response.status(409).json({ error: "已有阅读版正在构建，请稍后再试" });
    return;
  }
  pagesExportInProgress = true;
  try {
    const staged = findStagedBook(root, request.body?.uploadToken);
    if (!staged) throw new Error("待发布原书不存在，请重新导出");
    const manifest = sanitizePagesManifest(request.body, staged);
    publishStagedPagesBook(root, staged, manifest);
    await execFileAsync(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.pages.config.js"], {
      cwd: root,
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
    });
    response.json({
      ok: true,
      previewUrl: "/pages-preview/",
      exportedAt: manifest.exportedAt,
      stats: manifest.stats,
      message: "静态阅读版已更新；提交并推送仓库后，GitHub Pages 会自动部署。",
    });
  } catch (error) {
    console.error(`[pages-export] ${error.message}`);
    response.status(400).json({ error: error.message });
  } finally {
    pagesExportInProgress = false;
  }
});

app.use(express.json({ limit: "128kb" }));

function parseJsonObject(content) {
  const cleaned = String(content ?? "").trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("模型没有返回有效 JSON");
  return JSON.parse(cleaned.slice(first, last + 1));
}

function publicStatus() {
  return {
    ...modelProfiles.publicStatus(),
    promptVersion: PROMPT_VERSION,
    mode: "local-api-proxy",
  };
}

app.get("/api/status", (_request, response) => {
  response.set("Cache-Control", "no-store");
  response.json(publicStatus());
});

app.post("/api/config", (request, response) => {
  try {
    modelProfiles.save({ model: request.body?.model, apiKey: request.body?.apiKey,
      thinking: request.body?.thinking, concurrency: request.body?.concurrency });
    response.set("Cache-Control", "no-store");
    response.json(publicStatus());
  } catch (error) {
    console.error(`[config] ${error.message}`);
    response.status(400).json({ error: error.message });
  }
});

function normalizeProtectedTerms(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length >= 2 && item.length <= 100),
  )].slice(0, 100);
}

async function requestReplacementCandidates({
  profile,
  plans,
  level,
  density,
  protectedTerms,
  mode = "initial",
}) {
  const analyzerContent = await qwenRequest(baseUrl, profile, {
    model: profile.model,
    messages: [
      { role: "system", content: MIX_ANALYZER_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildAnalyzerUserPrompt({
          paragraphs: plans,
          level,
          density,
          mode,
          protectedTerms,
        }),
      },
    ],
    temperature: 0.1,
    max_completion_tokens: 12000,
    ...thinkingRequestOptions(profile.thinking, profile.model),
  }, profile.thinking === "disabled" ? 120000 : 300000);
  const parsed = parseJsonObject(analyzerContent);
  if (!Array.isArray(parsed.paragraphs) || plans.some((plan) =>
    !parsed.paragraphs.some((item) => String(item.id) === String(plan.id) && Array.isArray(item.replacements)))) {
    throw new Error("模型未返回全部段落的有效结果，本批尚未完成，可稍后续译");
  }
  return new Map((parsed.paragraphs ?? []).map((item) => [
    String(item.id),
    Array.isArray(item.replacements) ? item.replacements : [],
  ]));
}

function validatePlanCandidates(plan, candidates, density, protectedTerms) {
  return validateReplacements(plan.source, candidates, {
    minConfidence: 0.86,
    maxDensityPercent: density,
    minimumChangedUnits: 2,
    rejectProperNouns: true,
    protectedTerms,
  });
}

app.post("/api/mix", async (request, response) => {
  try {
    // Pin credentials and model for both the initial and supplemental request.
    const profile = modelProfiles.get(request.body?.model);
    profile.thinking = normalizeThinking(request.body?.thinking ?? profile.thinking);
    if (!profile.apiKey) throw new Error("所选模型尚未配置 API Key，请先在左侧保存");
    const paragraphs = request.body?.paragraphs;
    const density = normalizeDensity(request.body?.density);
    const level = normalizeLevel(request.body?.level);
    const protectedTerms = normalizeProtectedTerms(request.body?.protectedTerms);
    if (!Array.isArray(paragraphs) || paragraphs.length < 1 || paragraphs.length > 3) throw new Error("每批必须包含 1 至 3 个段落");
    const normalized = paragraphs.map((item, index) => {
      const id = String(item?.id ?? `p-${index}`);
      const text = String(item?.text ?? "").trim();
      if (!text || text.length > 5000) throw new Error(`段落 ${id} 为空或过长`);
      return { id, text };
    });
    if (normalized.reduce((sum, item) => sum + item.text.length, 0) > 12000) throw new Error("本批文字总量过大");

    const plans = normalized.map((item) => buildParagraphPlan(item, density));
    const initialCandidates = await requestReplacementCandidates({
      profile,
      plans,
      level,
      density,
      protectedTerms,
    });
    let validations = new Map(plans.map((plan) => [
      plan.id,
      validatePlanCandidates(plan, initialCandidates.get(plan.id), density, protectedTerms),
    ]));
    const underfilledPlans = plans.filter((plan) => {
      const accepted = validations.get(plan.id)?.accepted ?? [];
      const changedUnits = countReplacementSourceCharacters(accepted);
      const minimumCoverage = Math.max(2, Math.floor(plan.targetSourceCharacterCount * 0.6));
      return accepted.length < plan.minimumReplacementCount || changedUnits < minimumCoverage;
    });
    let supplementalPassUsed = false;
    let haltError;
    if (underfilledPlans.length) {
      supplementalPassUsed = true;
      const supplementPlans = underfilledPlans.map((plan) => {
        const accepted = validations.get(plan.id)?.accepted ?? [];
        const changedUnits = countReplacementSourceCharacters(accepted);
        return {
          ...plan,
          alreadySelectedSources: accepted.map((item) => item.source),
          requiredAdditionalSourceCharacters: Math.max(2, plan.targetSourceCharacterCount - changedUnits),
          minimumAdditionalReplacementCount: Math.max(1, plan.minimumReplacementCount - accepted.length),
        };
      });
      try {
        const supplementalCandidates = await requestReplacementCandidates({
          profile,
          plans: supplementPlans,
          level,
          density,
          protectedTerms,
          mode: "supplement",
        });
        validations = new Map(plans.map((plan) => {
          const combined = [
            ...(initialCandidates.get(plan.id) ?? []),
            ...(supplementalCandidates.get(plan.id) ?? []),
          ];
          return [plan.id, validatePlanCandidates(plan, combined, density, protectedTerms)];
        }));
      } catch (supplementError) {
        console.warn(`[mix] 补选未完成：${supplementError.message}`);
        haltError = publicApiError(supplementError);
      }
    }
    const safeParagraphs = plans.map((plan) => {
      const validation = validations.get(plan.id) ?? { accepted: [], rejected: [] };
      return {
        id: plan.id,
        replacements: validation.accepted,
        diagnostics: buildMixDiagnostics(
          plan,
          validation.accepted,
          validation.rejected.length,
          supplementalPassUsed && underfilledPlans.some((item) => item.id === plan.id),
        ),
      };
    });
    response.json({ paragraphs: safeParagraphs, model: profile.model, thinking: profile.thinking,
      promptVersion: PROMPT_VERSION, ...(haltError ? { haltError } : {}) });
  } catch (error) {
    const details = publicApiError(error);
    console.error(`[mix] ${details.error}`);
    response.status(error.status || 400).json(details);
  }
});

if (isProduction) {
  const dist = path.join(root, "dist");
  const pagesDist = path.join(root, "pages-reader", "dist");
  if (!fs.existsSync(dist)) throw new Error("dist 不存在，请先运行 npm run build");
  if (fs.existsSync(pagesDist)) {
    app.use("/pages-preview", express.static(pagesDist));
    app.get("/pages-preview/{*splat}", (_request, response) => response.sendFile(path.join(pagesDist, "index.html")));
  }
  app.use(express.static(dist));
  app.get("*splat", (_request, response) => response.sendFile(path.join(dist, "index.html")));
} else {
  const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.listen(port, "127.0.0.1", () => {
  console.log(`词间阅读器已启动：http://127.0.0.1:${port}`);
  const status = publicStatus();
  console.log(status.configured ? `API 已配置：${status.model}` : "API 未配置：可在网页左侧填写模型名称和 DashScope API Key");
});
