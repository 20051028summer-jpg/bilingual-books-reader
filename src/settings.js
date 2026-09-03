export const DENSITY_PERCENTAGES = Object.freeze({
  light: 10,
  medium: 20,
  dense: 40,
});

export function normalizeDensity(value = "medium") {
  const density = typeof value === "string" && value in DENSITY_PERCENTAGES
    ? DENSITY_PERCENTAGES[value]
    : Number(value);
  if (![10, 20, 40].includes(density)) throw new Error("替换密度必须是 10%、20% 或 40%");
  return density;
}

export function normalizeLevel(value = "cet6") {
  const level = String(value).toUpperCase().replace("-", "");
  if (level === "CET4") return "CET-4";
  if (level === "CET6") return "CET-6";
  throw new Error("学习水平必须是 CET-4 或 CET-6");
}

