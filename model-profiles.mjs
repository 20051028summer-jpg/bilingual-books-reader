import fs from "node:fs";
import { normalizeThinking, normalizeConcurrency, validateThinkingForModel } from "./src/request-settings.js";

export function normalizeModel(value) {
  const model = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)) {
    throw new Error("请输入有效模型名称（英文、数字、点、横线、下划线、冒号或斜杠）");
  }
  return model;
}

// Keys stay server-side. The legacy env file is only used on first migration.
export function createModelProfiles(filePath, legacy = {}) {
  const defaultModel = normalizeModel(legacy.model || "qwen-flash");
  let data = { version: 1, activeModel: defaultModel, profiles: {} };

  function persist(next) {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    data = next;
  }

  if (fs.existsSync(filePath)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (loaded.version !== 1 || !loaded.profiles || Array.isArray(loaded.profiles)
          || typeof loaded.profiles !== "object") throw new Error();
      normalizeModel(loaded.activeModel);
      for (const [name, profile] of Object.entries(loaded.profiles)) {
        normalizeModel(name);
        if (!profile || typeof profile.apiKey !== "string" || !profile.apiKey.trim()
            || /[\r\n]/.test(profile.apiKey)) throw new Error();
      }
      if (!Object.hasOwn(loaded.profiles, loaded.activeModel)) throw new Error();
      data = loaded;
    } catch {
      throw new Error("本机模型配置文件无法读取，请检查 .model-profiles.local.json；原文件未被覆盖");
    }
  } else if (legacy.apiKey?.trim()) {
    persist({ ...data, profiles: { [defaultModel]: { apiKey: legacy.apiKey.trim() } } });
  }

  function get(model = data.activeModel) {
    const name = normalizeModel(model);
    const profile = Object.hasOwn(data.profiles, name) ? data.profiles[name] : null;
    return { model: name, apiKey: profile?.apiKey || "",
      thinking: normalizeThinking(profile?.thinking), concurrency: normalizeConcurrency(profile?.concurrency) };
  }

  return {
    get,
    publicStatus() {
      return {
        model: data.activeModel,
        configured: Boolean(get().apiKey),
        savedModels: Object.keys(data.profiles).sort(),
        thinking: get().thinking,
        concurrency: get().concurrency,
        savedSettings: Object.fromEntries(Object.keys(data.profiles).map((name) => {
          const { thinking, concurrency } = get(name);
          return [name, { thinking, concurrency }];
        })),
      };
    },
    save({ model = data.activeModel, apiKey = "", thinking, concurrency }) {
      const name = normalizeModel(model);
      const key = String(apiKey).trim();
      if (key && (!key.startsWith("sk-") || /[\r\n]/.test(key))) throw new Error("API Key 格式不正确");
      const nextKey = key || get(name).apiKey;
      if (!nextKey) throw new Error("这个模型尚未保存 API Key，请首次填写后保存；其他模型的 Key 会继续保留");
      const previous = get(name);
      const options = { thinking: validateThinkingForModel(thinking ?? previous.thinking, name),
        concurrency: normalizeConcurrency(concurrency ?? previous.concurrency) };
      persist({
        version: 1,
        activeModel: name,
        profiles: { ...data.profiles, [name]: { apiKey: nextKey, ...options } },
      });
      return this.publicStatus();
    },
  };
}
