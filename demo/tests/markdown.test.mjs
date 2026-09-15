// Unit tests for the on-screen Markdown renderer (demo/ui/markdown.js), run with node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../ui/markdown.js";

test("escapes html and renders the supported subset", () => {
  assert.equal(renderMarkdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(renderMarkdown("# Title\n\nSome **bold** and *it* and `x<y`."),
    "<h3>Title</h3><p>Some <strong>bold</strong> and <em>it</em> and <code>x&lt;y</code>.</p>");
  assert.equal(renderMarkdown("- a\n- b\n\n1. one\n2. two"), "<ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>");
  assert.equal(renderMarkdown("```js\nlet a = 1 < 2;\n```"), '<pre class="md-code"><code data-lang="js">let a = 1 &lt; 2;</code></pre>');
  assert.equal(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"),
    '<table class="md-table"><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  assert.equal(renderMarkdown("> quoted"), "<blockquote>quoted</blockquote>");
});

test("links only over http(s); javascript: never", () => {
  assert.equal(renderMarkdown("[ok](https://example.com/a?b=1)"), '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener">ok</a></p>');
  assert.equal(renderMarkdown("[bad](javascript:alert(1))"), "<p>[bad](javascript:alert(1))</p>");
});

test("math falls back to code when KaTeX is absent, and uses it when present", () => {
  delete globalThis.katex;
  assert.equal(renderMarkdown("Area $A = \\pi r^2$ here"), '<p>Area <code class="md-math">A = \\pi r^2</code> here</p>');
  assert.equal(renderMarkdown("$$\nx = 1\n$$"), '<div class="md-display"><pre class="md-math">x = 1</pre></div>');
  globalThis.katex = { renderToString: (tex, opts) => `<span class="k" data-display="${opts.displayMode}">${tex}</span>` };
  assert.equal(renderMarkdown("$$ x^2 $$"), '<div class="md-display"><span class="k" data-display="true"> x^2 </span></div>');
  assert.equal(renderMarkdown("so $y$"), '<p>so <span class="k" data-display="false">y</span></p>');
  delete globalThis.katex;
});
