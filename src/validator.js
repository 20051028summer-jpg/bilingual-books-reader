const hanPattern = /\p{Script=Han}/u;
const englishPattern = /[A-Za-z]/;
const allowedReplacementPattern = /^[A-Za-z][A-Za-z\s'’\-.,!?()]*$/;

function codePointOffsetToCodeUnit(text, offset) {
  if (!Number.isInteger(offset) || offset < 0) return -1;
  return [...text].slice(0, offset).join("").length;
}

function allOccurrences(text, needle) {
  const result = [];
  let cursor = 0;
  while (needle && cursor <= text.length - needle.length) {
    const index = text.indexOf(needle, cursor);
    if (index < 0) break;
    result.push(index);
    cursor = index + Math.max(needle.length, 1);
  }
  return result;
}

function wordBoundaries(text) {
  const boundaries = new Set([0, text.length]);
  if (typeof Intl?.Segmenter !== "function") return boundaries;
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  for (const item of segmenter.segment(text)) {
    boundaries.add(item.index);
    boundaries.add(item.index + item.segment.length);
  }
  return boundaries;
}

function countHanCharacters(value) {
  return [...String(value ?? "")].filter((character) => hanPattern.test(character)).length;
}

function isInsideWorkTitle(text, start, end) {
  for (const [open, close] of [["《", "》"], ["〈", "〉"]]) {
    const openIndex = text.lastIndexOf(open, start);
    const closeBefore = text.lastIndexOf(close, start);
    const closeAfter = text.indexOf(close, end);
    if (openIndex > closeBefore && closeAfter >= end) return true;
  }
  return false;
}

function isProtectedTerm(source, protectedTerms) {
  return (Array.isArray(protectedTerms) ? protectedTerms : []).some((term) => {
    const normalized = String(term ?? "").trim();
    return normalized === source || (source.length >= 3 && normalized.includes(source));
  });
}

function hasProperNounContext(text, start, end) {
  const before = text.slice(Math.max(0, start - 8), start);
  const after = text.slice(end, Math.min(text.length, end + 6));
  return /(?:作者|名叫|叫作|笔名|艺名|姓)[:：]?\s*$/.test(before)
    || /^(?:先生|女士|老师|教授|将军|导演|总统|皇帝|陛下)/.test(after);
}

export function validateReplacements(text, candidates, options = {}) {
  const minConfidence = options.minConfidence ?? 0.86;
  const maxDensity = (options.maxDensityPercent ?? 22) / 100;
  const minimumChangedUnits = options.minimumChangedUnits ?? 6;
  const boundaries = wordBoundaries(text);
  const accepted = [];
  const rejected = [];

  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const source = typeof raw?.source === "string" ? raw.source.trim() : "";
    const replacement = typeof raw?.replacement === "string" ? raw.replacement.trim() : "";
    const confidence = Number(raw?.confidence);
    let start = -1;

    if (!source || [...source].length < 2 || !hanPattern.test(source)) {
      rejected.push({ candidate: raw, reason: "source_not_complete_chinese_unit" });
      continue;
    }
    if (!replacement || !englishPattern.test(replacement) || !allowedReplacementPattern.test(replacement)) {
      rejected.push({ candidate: raw, reason: "replacement_not_plain_english" });
      continue;
    }
    if (!Number.isFinite(confidence) || confidence < minConfidence) {
      rejected.push({ candidate: raw, reason: "confidence_too_low" });
      continue;
    }

    if (Number.isInteger(raw.start)) {
      const proposedStart = codePointOffsetToCodeUnit(text, raw.start);
      if (proposedStart >= 0 && text.slice(proposedStart, proposedStart + source.length) === source) {
        start = proposedStart;
      }
    }
    if (start < 0) {
      const occurrences = allOccurrences(text, source);
      if (occurrences.length !== 1) {
        rejected.push({ candidate: raw, reason: occurrences.length ? "source_ambiguous" : "source_not_found" });
        continue;
      }
      start = occurrences[0];
    }

    const end = start + source.length;
    if (
      options.rejectProperNouns
      && (
        /[A-Z]/.test(replacement)
        || isInsideWorkTitle(text, start, end)
        || isProtectedTerm(source, options.protectedTerms)
        || hasProperNounContext(text, start, end)
      )
    ) {
      rejected.push({ candidate: raw, reason: "proper_noun_or_transliteration" });
      continue;
    }
    if (!boundaries.has(start) || !boundaries.has(end)) {
      rejected.push({ candidate: raw, reason: "breaks_word_boundary" });
      continue;
    }
    if (accepted.some((item) => start < item.end && end > item.start)) {
      rejected.push({ candidate: raw, reason: "overlaps_existing_replacement" });
      continue;
    }

    accepted.push({
      start,
      end,
      source,
      replacement,
      lemma: typeof raw.lemma === "string" ? raw.lemma.trim() : replacement,
      gloss: typeof raw.gloss === "string" ? raw.gloss.trim() : "",
      confidence,
    });
  }

  accepted.sort((a, b) => a.start - b.start);
  // Density is a chapter-level learning preference. A short sentence must still be
  // allowed to contain one complete phrase (for example “精致的发卡”), otherwise a
  // percentage-only cap would encourage unsafe partial-word replacements.
  const maxChangedUnits = Math.max(minimumChangedUnits, Math.floor(countHanCharacters(text) * maxDensity));
  let changedUnits = 0;
  const densitySafe = [];
  for (const item of accepted) {
    const units = countHanCharacters(item.source);
    if (changedUnits + units > maxChangedUnits) {
      rejected.push({ candidate: item, reason: "density_limit" });
      continue;
    }
    densitySafe.push(item);
    changedUnits += units;
  }
  return { accepted: densitySafe, rejected };
}

export function renderMixedSegments(text, replacements) {
  const segments = [];
  let cursor = 0;
  for (const item of replacements) {
    if (item.start > cursor) segments.push({ type: "source", text: text.slice(cursor, item.start) });
    segments.push({ type: "replacement", text: item.replacement, meta: item });
    cursor = item.end;
  }
  if (cursor < text.length) segments.push({ type: "source", text: text.slice(cursor) });
  return segments;
}
