/**
 * Zerlegt eine Notiz in Folien (Trenner: eine Zeile, die nur aus `---` besteht,
 * außerhalb von Codeblöcken) und setzt sie exakt wieder zusammen.
 */

export interface Deck {
	/** Frontmatter inkl. der beiden `---`-Zeilen, sonst "" */
	frontmatter: string;
	/** Rohtext jeder Folie (inkl. Zeilenumbrüche) */
	slides: string[];
	/** Trennerzeilen zwischen den Folien (separators[i] steht nach slides[i]) */
	separators: string[];
}

const SEPARATOR = /^---[ \t]*\r?\n?$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function splitLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function parseDeck(text: string): Deck {
	const lines = splitLines(text);
	let start = 0;
	let frontmatter = "";

	if (lines.length > 0 && SEPARATOR.test(lines[0])) {
		for (let i = 1; i < lines.length; i++) {
			if (/^(---|\.\.\.)[ \t]*\r?\n?$/.test(lines[i])) {
				frontmatter = lines.slice(0, i + 1).join("");
				start = i + 1;
				break;
			}
		}
	}

	const slides: string[] = [];
	const separators: string[] = [];
	let current = "";
	let fence: string | null = null;

	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		const m = line.match(FENCE);
		if (m) {
			const marker = m[1];
			if (fence === null) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
		}
		if (fence === null && !m && SEPARATOR.test(line)) {
			slides.push(current);
			separators.push(line);
			current = "";
		} else {
			current += line;
		}
	}
	slides.push(current);
	return { frontmatter, slides, separators };
}

export function serializeDeck(deck: Deck): string {
	let out = deck.frontmatter;
	deck.slides.forEach((s, i) => {
		out += s;
		if (i < deck.separators.length) out += deck.separators[i];
	});
	return out;
}

/** Index der Folie, in der die (0-basierte) Editorzeile liegt. */
export function slideIndexAtLine(deck: Deck, line: number): number {
	let cursor = (deck.frontmatter.match(/\n/g) ?? []).length;
	for (let i = 0; i < deck.slides.length; i++) {
		cursor += (deck.slides[i].match(/\n/g) ?? []).length;
		if (i < deck.separators.length) cursor += 1;
		if (line < cursor) return i;
	}
	return Math.max(0, deck.slides.length - 1);
}

/** Ein Markdown-Block einer Folie; `gap` sind die Leerzeilen danach. join(text+gap) === Folientext */
export interface Chunk {
	text: string;
	gap: string;
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
const COMMENT_LINE = /^\s*<!--.*-->\s*$/;

/**
 * Zerlegt einen Folientext in Blöcke (getrennt durch Leerzeilen). Listen mit Leerzeilen
 * zwischen den Punkten bleiben ein Block, Code-/Mathe-Blöcke ebenso, Kommentarzeilen
 * (Flags) sind eigene Blöcke.
 */
export function splitChunks(src: string): Chunk[] {
	const chunks: Chunk[] = [];
	let cur: Chunk | null = null;
	let fence: string | null = null;
	let forceNew = false;

	for (const line of splitLines(src)) {
		if (fence !== null && cur) {
			cur.text += line;
			const t = line.trim();
			if (fence === "$$" ? t.endsWith("$$") : t.startsWith(fence[0].repeat(fence.length)) && /^[`~]+$/.test(t)) {
				fence = null;
				forceNew = true;
			}
			continue;
		}
		if (/^\s*$/.test(line)) {
			if (!cur) cur = { text: "", gap: "" };
			cur.gap += line;
			continue;
		}
		const firstLine = cur?.text.split("\n")[0] ?? "";
		const lastLine = cur?.text.replace(/\r?\n$/, "").split("\n").pop() ?? "";
		if (cur && cur.text !== "" && cur.gap === "" && !forceNew && !COMMENT_LINE.test(line) && !COMMENT_LINE.test(lastLine)) {
			cur.text += line;
		} else if (cur && cur.gap !== "" && LIST_ITEM.test(firstLine) && (LIST_ITEM.test(line) || /^(\s{2,}|\t)/.test(line))) {
			cur.text += cur.gap + line;
			cur.gap = "";
		} else {
			if (cur) chunks.push(cur);
			cur = { text: line, gap: "" };
		}
		forceNew = false;

		const fm = line.match(FENCE);
		if (fm) fence = fm[1];
		else if (/^\s*\$\$/.test(line) && !/^\s*\$\$.*\$\$\s*$/.test(line)) fence = "$$";
	}
	if (cur) chunks.push(cur);
	return chunks;
}

export function joinChunks(chunks: Chunk[]): string {
	return chunks.map((c) => c.text + c.gap).join("");
}

export type SlideFlags = Record<string, string>;

const FLAG_COMMENT = /<!--\s*([\s\S]*?)\s*-->/g;
const KNOWN_FLAGS = ["layout", "caption", "fit", "align"];

/** Liest Flags wie `<!-- layout: bild-links -->` und entfernt diese Kommentare. */
export function extractFlags(src: string): { flags: SlideFlags; body: string } {
	const flags: SlideFlags = {};
	const body = src.replace(FLAG_COMMENT, (whole, inner: string) => {
		const pairs = inner.split(/[;,]/).map((p) => p.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/));
		if (pairs.length === 0 || pairs.some((p) => !p || !KNOWN_FLAGS.includes(p[1].toLowerCase()))) {
			return whole;
		}
		for (const p of pairs) if (p) flags[p[1].toLowerCase()] = p[2].toLowerCase();
		return "";
	});
	return { flags, body };
}

export type Layout =
	| "auto"
	| "titel"
	| "text"
	| "zentriert"
	| "bild-links"
	| "bild-rechts"
	| "bild-oben"
	| "bild-unten"
	| "bild-voll";

const ALIASES: Record<string, Layout> = {
	auto: "auto",
	titel: "titel",
	title: "titel",
	text: "text",
	gestapelt: "text",
	stack: "text",
	zentriert: "zentriert",
	center: "zentriert",
	"bild-links": "bild-links",
	"image-left": "bild-links",
	"bild-rechts": "bild-rechts",
	"image-right": "bild-rechts",
	"bild-oben": "bild-oben",
	"image-top": "bild-oben",
	"bild-unten": "bild-unten",
	"image-bottom": "bild-unten",
	"bild-voll": "bild-voll",
	vollbild: "bild-voll",
	"image-full": "bild-voll",
};

export function normalizeLayout(value: string | undefined): Layout {
	if (!value) return "auto";
	return ALIASES[value.trim().toLowerCase()] ?? "auto";
}
