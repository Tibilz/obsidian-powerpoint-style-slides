/**
 * Wandelt gerenderte (und im Präsentationsmodus bearbeitete) Blöcke zurück in Markdown.
 * Alles, was nicht sicher zurückübersetzt werden kann, wirft `Unsupported` – solche
 * Blöcke werden dann als Markdown direkt in der Folie bearbeitet.
 */

export class Unsupported extends Error {}

const UNSUPPORTED_SEL =
	"img, video, svg, iframe, canvas, .math, mjx-container, .internal-embed, .footnote-ref, sup, sub, .callout, input:not([type=checkbox]), .mermaid, details";

function escapeText(s: string): string {
	return s.replace(/ /g, " ").replace(/([*`[\]])/g, "\\$1");
}

function wrap(mark: string, inner: string): string {
	if (!inner.trim()) return inner;
	// Leerzeichen gehören außerhalb der Markierung, sonst ist es kein gültiges Markdown
	const lead = inner.match(/^\s*/)![0];
	const trail = inner.match(/\s*$/)![0];
	return `${lead}${mark}${inner.trim()}${mark}${trail}`;
}

export function inlineToMd(node: Node): string {
	let out = "";
	node.childNodes.forEach((n) => {
		if (n.nodeType === Node.TEXT_NODE) { out += escapeText(n.textContent ?? ""); return; }
		if (n.nodeType !== Node.ELEMENT_NODE) return;
		const el = n as HTMLElement;
		if (el.matches(UNSUPPORTED_SEL)) throw new Unsupported(el.tagName);
		switch (el.tagName) {
			case "STRONG": case "B": out += wrap("**", inlineToMd(el)); break;
			case "EM": case "I": out += wrap("*", inlineToMd(el)); break;
			case "DEL": case "S": case "STRIKE": out += wrap("~~", inlineToMd(el)); break;
			case "MARK": out += wrap("==", inlineToMd(el)); break;
			case "CODE": out += "`" + (el.textContent ?? "") + "`"; break;
			case "BR": out += "\n"; break;
			case "A": {
				const text = inlineToMd(el);
				if (el.hasClass("tag")) { out += el.textContent ?? ""; break; }
				if (el.hasClass("internal-link")) {
					const target = el.getAttribute("data-href") ?? el.getAttribute("href") ?? text;
					out += target === (el.textContent ?? "") ? `[[${target}]]` : `[[${target}|${text}]]`;
					break;
				}
				const href = el.getAttribute("href") ?? "";
				out += href === (el.textContent ?? "") ? href : `[${text}](${href})`;
				break;
			}
			case "DIV": case "P": {
				// Chromium legt beim Tippen manchmal <div>/<p> innerhalb des Blocks an
				const inner = inlineToMd(el);
				out += (out && !out.endsWith("\n") ? "\n" : "") + inner;
				break;
			}
			case "SPAN": case "FONT": case "U": out += inlineToMd(el); break;
			case "BUTTON": break;
			default: throw new Unsupported(el.tagName);
		}
	});
	return out;
}

function listToMd(list: HTMLElement, depth: number): string {
	const ordered = list.tagName === "OL";
	let n = Number(list.getAttribute("start") ?? 1);
	const lines: string[] = [];
	Array.from(list.children).forEach((child) => {
		if (child.tagName !== "LI") throw new Unsupported(child.tagName);
		const li = child as HTMLElement;
		let marker = ordered ? `${n++}. ` : "- ";
		const box = li.querySelector<HTMLInputElement>(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
		if (box) marker += box.checked || li.hasClass("is-checked") ? "[x] " : "[ ] ";
		const textPart = createDiv();
		const nested: HTMLElement[] = [];
		li.childNodes.forEach((c) => {
			if (c instanceof HTMLElement && (c.tagName === "UL" || c.tagName === "OL")) nested.push(c);
			else if (!(c instanceof HTMLInputElement)) textPart.appendChild(c.cloneNode(true));
		});
		textPart.querySelectorAll("input[type=checkbox], .list-bullet, .list-collapse-indicator").forEach((e) => e.remove());
		const indent = "\t".repeat(depth);
		const text = inlineToMd(textPart).trim().replace(/\n/g, `\n${indent}  `);
		lines.push(indent + marker + text);
		nested.forEach((l) => lines.push(listToMd(l, depth + 1)));
	});
	return lines.join("\n");
}

function tableToMd(table: HTMLElement): string {
	const rows = Array.from(table.querySelectorAll("tr"));
	const cell = (c: Element) => inlineToMd(c).replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
	const lines = rows.map((r) => "| " + Array.from(r.children).map(cell).join(" | ") + " |");
	const cols = rows[0]?.children.length ?? 0;
	lines.splice(1, 0, "|" + " --- |".repeat(cols));
	return lines.join("\n");
}

/** Ein gerendertes Block-Element → Markdown */
export function blockToMd(el: HTMLElement): string {
	const tag = el.tagName;
	if (/^H[1-6]$/.test(tag)) return "#".repeat(Number(tag[1])) + " " + inlineToMd(el).replace(/\n/g, " ").trim();
	if (tag === "P") return inlineToMd(el).trim();
	if (tag === "UL" || tag === "OL") return listToMd(el, 0);
	if (tag === "TABLE") return tableToMd(el);
	if (tag === "HR") return "***";
	if (tag === "BLOCKQUOTE" && !el.hasClass("callout")) {
		return Array.from(el.children).map((c) => blockToMd(c as HTMLElement)).join("\n\n")
			.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
	}
	if (tag === "DIV" && el.children.length === 1 && el.firstElementChild?.tagName === "TABLE") {
		return tableToMd(el.firstElementChild as HTMLElement);
	}
	throw new Unsupported(tag);
}

/** Grob normalisieren, um "bedeutet dasselbe" zu prüfen. */
function norm(md: string): string {
	return md
		.replace(/\\/g, "")
		.replace(/^\s*[-*+]\s+/gm, "-")
		.replace(/^\s*\d+[.)]\s+/gm, "1.")
		.replace(/:?-{3,}:?/g, "---")
		.replace(/_/g, "*")
		.replace(/[\s|]/g, "");
}

/**
 * Kann dieser Block verlustfrei per WYSIWYG bearbeitet werden? Dafür muss die Rückübersetzung
 * der unveränderten Darstellung (im Wesentlichen) wieder den Originaltext ergeben.
 */
export function canEditWysiwyg(els: HTMLElement[], source: string): boolean {
	try {
		return norm(els.map(blockToMd).join("\n")) === norm(source);
	} catch {
		return false;
	}
}
