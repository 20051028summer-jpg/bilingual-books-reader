const hanPattern = /\p{Script=Han}/u;

export function countHanCharacters(value) {
  return [...String(value ?? "")].filter((character) => hanPattern.test(character)).length;
}

export function countReplacementSourceCharacters(replacements) {
  return (Array.isArray(replacements) ? replacements : [])
    .reduce((total, item) => total + countHanCharacters(item?.source), 0);
}

export function buildParagraphPlan(paragraph, density) {
  const sourceCharacterCount = countHanCharacters(paragraph.text);
  const targetSourceCharacterCount = Math.max(2, Math.round(sourceCharacterCount * density / 100));
  const targetReplacementCount = Math.max(1, Math.round(targetSourceCharacterCount / 2.4));
  const minimumReplacementCount = Math.max(1, Math.floor(targetReplacementCount * 0.7));
  return {
    id: paragraph.id,
    source: paragraph.text,
    sourceCharacterCount,
    targetSourceCharacterCount,
    targetReplacementCount,
    minimumReplacementCount,
  };
}

export function buildMixDiagnostics(plan, replacements, rejectedCount, supplementalPassUsed = false) {
  const changedSourceCharacterCount = countReplacementSourceCharacters(replacements);
  const achievedDensityPercent = plan.sourceCharacterCount
    ? Number((changedSourceCharacterCount / plan.sourceCharacterCount * 100).toFixed(1))
    : 0;
  return {
    sourceCharacterCount: plan.sourceCharacterCount,
    changedSourceCharacterCount,
    targetSourceCharacterCount: plan.targetSourceCharacterCount,
    targetReplacementCount: plan.targetReplacementCount,
    minimumReplacementCount: plan.minimumReplacementCount,
    acceptedCount: replacements.length,
    rejectedCount,
    achievedDensityPercent,
    supplementalPassUsed,
  };
}

