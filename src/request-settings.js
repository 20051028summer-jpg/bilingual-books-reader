export const THINKING_LABELS = Object.freeze({ disabled: "关闭", low: "低", medium: "中", high: "高", max: "最大" });
const THINKING_BUDGETS = Object.freeze({ low: 1024, medium: 4096, high: 8192, max: 16384 });

export function normalizeThinking(value = "disabled") {
  // Migrate the old switches; fresh and formerly automatic configurations stay off.
  if (value === "enabled") return "high";
  if (value === "default") return "disabled";
  if (!Object.hasOwn(THINKING_LABELS, value)) throw new Error("思考强度必须为关闭、低、中、高或最大");
  return value;
}

export function thinkingCapabilities(model = "qwen-flash") {
  if (/^deepseek-v4-(?:flash|pro)(?:-|$)/i.test(model)) {
    const supportsLow = /^(?:deepseek-v4-flash-0731|deepseek-v4-pro-0813)$/i.test(model);
    return { modes: supportsLow ? ["disabled", "low", "high", "max"] : ["disabled", "high", "max"],
      hint: supportsLow ? "此模型支持低、高、最大；平台会将中映射为高，因此禁用中档。" : "此模型仅支持高、最大；平台会将低、中映射为高，因此禁用低、中。" };
  }
  if (/^qwen(?:-(?:flash|plus|turbo)|3(?:[.-]|$))/i.test(model)) {
    return { modes: Object.keys(THINKING_LABELS), budget: true,
      hint: "低／中／高／最大分别限制思考预算为 1024／4096／8192／16384 Token；档位越高可能越慢、费用越高。" };
  }
  return { modes: Object.keys(THINKING_LABELS), hint: "按 reasoning_effort 发送所选档位；可用档位以该模型接口为准，不支持时会提示错误。" };
}

export function validateThinkingForModel(mode, model) {
  const thinking = normalizeThinking(mode);
  if (!thinkingCapabilities(model).modes.includes(thinking)) throw new Error(`${model} 不支持独立的“${THINKING_LABELS[thinking]}”思考档位，请选择可用档位`);
  return thinking;
}

export function normalizeConcurrency(value = 3) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 6) throw new Error("并行数必须为 1 至 6");
  return number;
}

export function thinkingRequestOptions(mode, model = "qwen-flash") {
  const thinking = validateThinkingForModel(mode, model);
  if (thinking === "disabled") return { enable_thinking: false, response_format: { type: "json_object" } };
  // Some thinking models require streaming and cannot enforce JSON mode.
  if (thinkingCapabilities(model).budget) {
    const budget = THINKING_BUDGETS[thinking];
    return { stream: true, enable_thinking: true, thinking_budget: budget, max_completion_tokens: budget + 12000 };
  }
  return { stream: true, enable_thinking: true, reasoning_effort: thinking };
}
