// Small, safe Markdown renderer for things the assistant shows on screen.
// Everything is HTML-escaped first; only a known subset is turned into markup:
// headings, paragraphs, bold/italic/inline code, fenced code, lists, tables,
// http(s) links, blockquotes, and math ($...$ / $$...$$) via KaTeX when it is
// loaded (window.katex), else shown as code. No raw HTML ever passes through.

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Placeholder marker for spans protected from further formatting (private-use codepoint).
const SLOT = "";
const SLOT_RE = /(\d+)/g;

/** @param {string} tex @param {boolean} display */
function renderMath(tex, display) {
  const katex = /** @type {any} */ (globalThis).katex;
  if (katex && typeof katex.renderToString === "function") {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" });
    } catch { /* fall through */ }
  }
  return display ? `<pre class="md-math">${esc(tex)}</pre>` : `<code class="md-math">${esc(tex)}</code>`;
}

/** Inline spans: code, math, bold, italic, links. Escapes everything else. @param {string} raw */
function inline(raw) {
  /** @type {string[]} */
  const slots = [];
  let text = raw;
  // Protect inline code and math from further formatting.
  text = text.replace(/`([^`\n]+)`/g, (_, c) => { slots.push(`<code>${esc(c)}</code>`); return `${SLOT}${slots.length - 1}${SLOT}`; });
  text = text.replace(/\$([^$\n]+?)\$/g, (_, m) => { slots.push(renderMath(m, false)); return `${SLOT}${slots.length - 1}${SLOT}`; });
  text = esc(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`);
  return text.replace(SLOT_RE, (_, i) => slots[Number(i)]);
}

/** @param {string} row */
const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const TABLE_SEP = /^\s*\|?\s*:?-{2,}/;
const BLOCK_START = /^(```|\$\$|#{1,4}\s|>\s?|\s*([-*+]|\d+[.)])\s)/;

/** @param {string} md @returns {string} HTML */
export function renderMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  /** @type {string[]} */
  const html = [];
  let i = 0;
  const startsTable = (k) => k + 1 < lines.length && /\|/.test(lines[k]) && TABLE_SEP.test(lines[k + 1]);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      html.push(`<pre class="md-code"><code${fence[1] ? ` data-lang="${esc(fence[1])}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\$\$\s*$/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      html.push(`<div class="md-display">${renderMath(body.join("\n"), true)}</div>`);
      continue;
    }
    const oneLineMath = /^\$\$(.+)\$\$\s*$/.exec(line);
    if (oneLineMath) { html.push(`<div class="md-display">${renderMath(oneLineMath[1], true)}</div>`); i++; continue; }
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) { const n = Math.min(4, h[1].length + 2); html.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (startsTable(i)) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
      html.push(`<table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.+)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(`<li>${inline(m[2])}</li>`);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ""));
      html.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i]) && !startsTable(i)) para.push(lines[i++]);
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    else i++;
  }
  return html.join("");
}
