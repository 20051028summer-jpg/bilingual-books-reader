import { renderMixedSegments } from "./validator.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

export function renderMixedHtml(text, replacements) {
  return renderMixedSegments(text, replacements)
    .map((segment) => {
      if (segment.type === "source") return escapeHtml(segment.text);
      const english = escapeHtml(segment.text);
      const source = escapeHtml(segment.meta.source);
      return `<button type="button" class="mixed-word" data-english="${english}" data-source="${source}" data-showing="english" aria-pressed="false" aria-label="${english}，点击显示原文" title="点击显示原文">${english}</button>`;
    })
    .join("");
}

