import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeck, serializeDeck, extractFlags, normalizeLayout, slideIndexAtLine } from "../src/parser.ts";

const doc = `---
title: X
---
# Eins
- a

---
# Zwei
\`\`\`
---
\`\`\`
---
<!-- layout: bild-links -->
![[a.png]]
`;

test("splits on --- outside code fences, skips frontmatter", () => {
  const d = parseDeck(doc);
  assert.equal(d.frontmatter, "---\ntitle: X\n---\n");
  assert.equal(d.slides.length, 3);
  assert.match(d.slides[1], /```\n---\n```/);
});

test("roundtrip is exact", () => {
  assert.equal(serializeDeck(parseDeck(doc)), doc);
  const crlf = doc.replace(/\n/g, "\r\n");
  assert.equal(serializeDeck(parseDeck(crlf)), crlf);
  assert.equal(serializeDeck(parseDeck("nur text")), "nur text");
});

test("replacing one slide keeps the rest", () => {
  const d = parseDeck(doc);
  d.slides[0] = "# Neu\n\n";
  const out = serializeDeck(d);
  assert.ok(out.startsWith("---\ntitle: X\n---\n# Neu\n\n---\n# Zwei"));
});

test("extracts flags and strips them", () => {
  const { flags, body } = extractFlags("<!-- layout: Bild-Links; caption: off -->\n# T\n");
  assert.equal(flags.layout, "bild-links");
  assert.equal(flags.caption, "off");
  assert.equal(body.trim(), "# T");
  assert.equal(extractFlags("<!-- normaler kommentar -->\nx").flags.layout, undefined);
});

test("normalizes layout aliases", () => {
  assert.equal(normalizeLayout("image-left"), "bild-links");
  assert.equal(normalizeLayout("title"), "titel");
  assert.equal(normalizeLayout("quatsch"), "auto");
  assert.equal(normalizeLayout(undefined), "auto");
});

test("maps editor line to slide index", () => {
  const d = parseDeck(doc);
  assert.equal(slideIndexAtLine(d, 0), 0);
  assert.equal(slideIndexAtLine(d, 4), 0);
  assert.equal(slideIndexAtLine(d, 8), 1);
  assert.equal(slideIndexAtLine(d, 14), 2);
});

import { splitChunks } from "../src/parser.ts";
const join = (c: { text: string; gap: string }[]) => c.map((x) => x.text + x.gap).join("");

test("splitChunks roundtrips exactly", () => {
  const src = "\n<!-- layout: titel -->\n# T\ntext\n\n- a\n\n- b\n  weiter\n\n```js\nx\n\ny\n```\n\n$$\na\n\nb\n$$\nEnde";
  const c = splitChunks(src);
  assert.equal(join(c), src);
  const texts = c.map((x) => x.text).filter(Boolean);
  assert.deepEqual(texts, [
    "<!-- layout: titel -->\n",
    "# T\ntext\n",
    "- a\n\n- b\n  weiter\n",
    "```js\nx\n\ny\n```\n",
    "$$\na\n\nb\n$$\n",
    "Ende",
  ]);
});

test("splitChunks keeps paragraphs separate", () => {
  const c = splitChunks("eins\n\nzwei\n");
  assert.deepEqual(c.map((x) => x.text), ["eins\n", "zwei\n"]);
  assert.deepEqual(c.map((x) => x.gap), ["\n", ""]);
});
