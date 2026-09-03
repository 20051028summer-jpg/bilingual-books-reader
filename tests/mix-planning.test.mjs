import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMixDiagnostics,
  buildParagraphPlan,
  countHanCharacters,
} from "../src/mix-planning.js";

test("builds an explicit per-paragraph density target", () => {
  const text = "这是一段用于验证替换密度是否真的传给模型的中文文本内容";
  assert.equal(countHanCharacters(text), 27);
  const plan = buildParagraphPlan({ id: "p1", text }, 20);
  assert.equal(plan.sourceCharacterCount, 27);
  assert.equal(plan.targetSourceCharacterCount, 5);
  assert.equal(plan.targetReplacementCount, 2);
  assert.equal(plan.minimumReplacementCount, 1);
});

test("reports achieved density and supplemental-pass usage", () => {
  const plan = buildParagraphPlan({ id: "p1", text: "桌后坐着十来个评委" }, 20);
  const diagnostics = buildMixDiagnostics(plan, [
    { source: "评委", replacement: "judges" },
  ], 1, true);
  assert.equal(diagnostics.acceptedCount, 1);
  assert.equal(diagnostics.changedSourceCharacterCount, 2);
  assert.equal(diagnostics.supplementalPassUsed, true);
  assert.ok(diagnostics.achievedDensityPercent > 0);
});
