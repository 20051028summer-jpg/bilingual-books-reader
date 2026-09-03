import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalyzerUserPrompt, MIX_ANALYZER_SYSTEM_PROMPT, PROMPT_VERSION } from "../prompts/system-prompts.mjs";
import { normalizeDensity, normalizeLevel } from "../src/settings.js";

test("maps the three UI density levels to 10, 20, and 40 percent", () => {
  assert.equal(normalizeDensity("light"), 10);
  assert.equal(normalizeDensity("medium"), 20);
  assert.equal(normalizeDensity("dense"), 40);
  assert.throws(() => normalizeDensity(15), /10%、20% 或 40%/);
});

test("passes the selected learner level and density into the runtime prompt", () => {
  const payload = JSON.parse(buildAnalyzerUserPrompt({
    paragraphs: [{ id: "1", source: "桌后坐着十来个评委。" }],
    level: normalizeLevel("cet4"),
    density: normalizeDensity("dense"),
  }));
  assert.equal(payload.learnerLevel, "CET-4");
  assert.equal(payload.targetReplacementDensityPercent, 40);
  assert.equal(payload.selectionPolicy.primary, "single_english_words");
  assert.equal(payload.selectionPolicy.targetSingleWordSharePercent, 75);
  assert.match(MIX_ANALYZER_SYSTEM_PROMPT, /WORD FIRST/);
  assert.match(PROMPT_VERSION, /v4-density-proper-noun-guard/);
  assert.deepEqual(payload.excludedCategories.slice(0, 3), [
    "person_names",
    "place_names",
    "organizations",
  ]);
});
