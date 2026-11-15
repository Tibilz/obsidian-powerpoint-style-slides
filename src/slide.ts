import { App, Component, MarkdownRenderer } from "obsidian";
import { Chunk, extractFlags, Layout, normalizeLayout, splitChunks } from "./parser";

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

export interface FitSettings {
	baseFontSize: number;
	minFontSize: number;
}

type Kind = "heading" | "text" | "code" | "media";

interface Block {
	kind: Kind;
	el: HTMLElement;
}

const MEDIA_SEL = "img, video, svg, iframe, canvas, .image-embed, .media-embed, .mermaid";

/** Text eines Elements ohne Bildunterschriften (<em>) und ohne Medien. */
function plainText(el: HTMLElement, skipEm: boolean): string {
	const clone = el.cloneNode(true) as HTMLElement;
	clone.querySelectorAll(MEDIA_SEL).forEach((n) => n.remove());
	if (skipEm) clone.querySelectorAll("em").forEach((n) => n.remove());
	return (clone.textContent ?? "").trim();
}

function classify(el: HTMLElement): Kind {
	if (/^H[1-6]$/.test(el.tagName)) return "heading";
	if (el.tagName === "PRE" || (el.querySelector("pre") && !el.querySelector(".mermaid"))) return "code";
	if (el.matches(MEDIA_SEL) || el.querySelector(MEDIA_SEL)) {
		if (el.matches(".mermaid") || el.querySelector(".mermaid")) return "media";
		if (el.tagName === "P" && plainText(el, true) === "") return "media";
		if (el.matches(MEDIA_SEL)) return "media";
	}
	return "text";
}

/** Ist das ein Absatz, der nur aus kursivem Text besteht? → Bildunterschrift */
function captionText(el: HTMLElement | undefined): string | null {
	if (!el || el.tagName !== "P") return null;
	const ems = el.querySelectorAll(":scope > em");
	if (ems.length === 0 || plainText(el, true) !== "" || el.querySelector(MEDIA_SEL)) return null;
	return Array.from(ems).map((e) => e.textContent ?? "").join(" ").trim();
}

function makeFigure(block: HTMLElement, caption: string | null, captions: boolean, captionEl?: HTMLElement): HTMLElement {
	const fig = createEl("figure", { cls: "sf-figure" });
	fig.dataset.from = block.dataset.from;
	fig.dataset.to = captionEl?.dataset.to ?? block.dataset.to;
	const wrap = fig.createDiv({ cls: "sf-media-wrap" });
	// Kursiver Text im selben Absatz wie das Bild (Zeile direkt darunter) = Bildunterschrift
	let inner = caption;
	if (block.tagName === "P" && !captions) {
		wrap.appendChild(block);
	} else if (block.tagName === "P") {
		const ems = Array.from(block.querySelectorAll(":scope > em"));
		if (ems.length && inner === null) inner = ems.map((e) => e.textContent ?? "").join(" ").trim();
		ems.forEach((e) => e.remove());
		block.querySelectorAll(":scope > br").forEach((e) => e.remove());
		const media = Array.from(block.childNodes).filter(
			(n) => !(n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").trim())
		);
		if (media.length > 1) wrap.addClass("sf-multi");
		media.forEach((n) => wrap.appendChild(n));
	} else {
		wrap.appendChild(block);
	}
	if (inner) fig.createEl("figcaption", { text: inner });
	return fig;
}

/** MarkdownRenderer legt Blöcke direkt oder in div-Wrappern ab */
function topLevel(rendered: HTMLElement): HTMLElement[] {
	return (Array.from(rendered.children) as HTMLElement[]).flatMap((c) =>
		c.tagName === "DIV" && c.children.length === 1 && !c.className.includes("callout") && !c.matches(MEDIA_SEL)
			? [c.children[0] as HTMLElement]
			: [c]
	);
}

function collectBlocks(rendered: HTMLElement, captions: boolean): Block[] {
	let children = Array.from(rendered.children) as HTMLElement[];
	children = children.filter((c) => !(c.tagName === "P" && !c.textContent?.trim() && !c.querySelector(MEDIA_SEL)));

	const blocks: Block[] = [];
	for (let i = 0; i < children.length; i++) {
		const el = children[i];
		const kind = classify(el);
		if (kind === "media") {
			let cap: string | null = null;
			let capEl: HTMLElement | undefined;
			if (captions) {
				cap = captionText(children[i + 1]);
				if (cap !== null) capEl = children[++i];
			}
			blocks.push({ kind, el: makeFigure(el, cap, captions, capEl) });
		} else {
			blocks.push({ kind, el });
		}
	}
	return blocks;
}

function region(cls: string, blocks: Block[]): HTMLElement {
	const r = createDiv({ cls: `sf-region ${cls}` });
	blocks.forEach((b) => r.appendChild(b.el));
	if (cls.includes("sf-media") && blocks.length > 1) {
		r.addClass("sf-grid");
		r.style.setProperty("--sf-cols", String(Math.ceil(Math.sqrt(blocks.length))));
	}
	return r;
}

function chooseLayout(requested: Layout, head: Block | null, rest: Block[]): Layout {
	if (requested !== "auto") return requested;
	const has = (k: Kind) => rest.some((b) => b.kind === k);
	const textLen = rest.filter((b) => b.kind === "text").reduce((n, b) => n + (b.el.textContent?.length ?? 0), 0);
	if (!has("media") && !has("code")) {
		if (head && head.el.tagName === "H1" && textLen < 200 && rest.length <= 2) return "titel";
		if (head && rest.length === 0) return "titel";
		if (!head && textLen < 160 && rest.length <= 2) return "zentriert";
		return "text";
	}
	if (has("media") && !has("text") && !has("code")) return "bild-voll";
	return "auto";
}

function arrange(slide: HTMLElement, blocks: Block[], requested: Layout) {
	const head = blocks[0]?.kind === "heading" ? blocks[0] : null;
	const rest = head ? blocks.slice(1) : blocks;
	const layout = chooseLayout(requested, head, rest);
	slide.dataset.layout = layout;

	const content = slide.createDiv({ cls: "sf-content" });
	if (head && layout !== "titel") content.createDiv({ cls: "sf-header" }).appendChild(head.el);
	const body = content.createDiv({ cls: "sf-body" });

	const text = rest.filter((b) => b.kind === "text" || b.kind === "heading");
	const code = rest.filter((b) => b.kind === "code");
	const media = rest.filter((b) => b.kind === "media");
	const notMedia = rest.filter((b) => b.kind !== "media");

	const columns = (regions: HTMLElement[], fr: number[]) => {
		body.addClass("sf-columns");
		body.style.gridTemplateColumns = fr.map((f) => `minmax(0, ${f}fr)`).join(" ");
		regions.forEach((r) => body.appendChild(r));
	};
	const rows = (regions: HTMLElement[]) => {
		body.addClass("sf-rows");
		body.style.gridTemplateRows = regions.map((r) => (r.hasClass("sf-media") ? "minmax(0, 1fr)" : "auto")).join(" ");
		regions.forEach((r) => body.appendChild(r));
	};

	switch (layout) {
		case "titel":
			body.addClass("sf-single");
			body.appendChild(region("sf-flow", head ? [head, ...rest] : rest));
			break;
		case "text":
		case "zentriert":
			body.addClass("sf-single");
			body.appendChild(region("sf-flow", rest));
			break;
		case "bild-voll":
			body.addClass("sf-single");
			body.appendChild(region("sf-media", media.length ? media : rest));
			if (media.length && notMedia.length) body.appendChild(region("sf-flow", notMedia));
			break;
		case "bild-links":
			if (!media.length) return arrangeFallback();
			columns([region("sf-media", media), region("sf-flow", notMedia)], [1, 1.1]);
			break;
		case "bild-rechts":
			if (!media.length) return arrangeFallback();
			columns([region("sf-flow", notMedia), region("sf-media", media)], [1.1, 1]);
			break;
		case "bild-oben":
			rows([region("sf-media", media), region("sf-flow", notMedia)]);
			break;
		case "bild-unten":
			rows([region("sf-flow", notMedia), region("sf-media", media)]);
			break;
		default: {
			// auto mit gemischtem Inhalt: Stichpunkte links, Code mittig, Bilder rechts
			if (text.length && code.length && !media.length) {
				rows([region("sf-flow", text), region("sf-code", code)]);
			} else {
				const parts: HTMLElement[] = [];
				const fr: number[] = [];
				if (text.length) { parts.push(region("sf-flow", text)); fr.push(1); }
				if (code.length) { parts.push(region("sf-code", code)); fr.push(1.25); }
				if (media.length) { parts.push(region("sf-media", media)); fr.push(1); }
				if (parts.length === 1) { body.addClass("sf-single"); body.appendChild(parts[0]); }
				else columns(parts, fr);
			}
		}
	}

	function arrangeFallback() {
		body.addClass("sf-single");
		body.appendChild(region("sf-flow", rest));
	}
}

function overflows(el: HTMLElement): boolean {
	return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
}

/** Verkleinert die Schrift (und damit alles, was in em bemessen ist), bis nichts mehr übersteht. */
export function fitSlide(slide: HTMLElement, s: FitSettings) {
	const content = slide.querySelector<HTMLElement>(".sf-content");
	if (!content) return;
	const parts = [content, ...Array.from(slide.querySelectorAll<HTMLElement>(".sf-header, .sf-body, .sf-region, pre, table"))];
	const figures = Array.from(slide.querySelectorAll<HTMLElement>(".sf-figure"));
	const fits = (px: number) => {
		slide.style.setProperty("--sf-font", `${px}px`);
		// Bildhöhe = Platz der Figur minus Bildunterschrift, damit die Unterschrift direkt am Bild klebt
		figures.forEach((f) => f.style.removeProperty("--sf-media-h"));
		const heights = figures.map((f) => {
			const cap = f.querySelector<HTMLElement>("figcaption");
			const capH = cap ? cap.offsetHeight + parseFloat(getComputedStyle(cap).marginTop) : 0;
			return Math.max(20, f.clientHeight - capH);
		});
		figures.forEach((f, i) => f.style.setProperty("--sf-media-h", `${heights[i]}px`));
		return !parts.some(overflows);
	};
	if (fits(s.baseFontSize)) { slide.dataset.scale = "1"; return; }
	// Unterhalb der Mindestgröße wird trotzdem weiter verkleinert: lieber klein als abgeschnitten
	let lo = fits(s.minFontSize) ? s.minFontSize : 3;
	let hi = s.baseFontSize;
	for (let i = 0; i < 9 && hi - lo > 0.25; i++) {
		const mid = (lo + hi) / 2;
		if (fits(mid)) lo = mid; else hi = mid;
	}
	fits(lo);
	slide.dataset.scale = (lo / s.baseFontSize).toFixed(2);
}

function waitForMedia(el: HTMLElement, timeout = 4000): Promise<void> {
	const imgs = Array.from(el.querySelectorAll("img")).filter((i) => !i.complete);
	if (!imgs.length) return Promise.resolve();
	return Promise.race([
		Promise.all(imgs.map((i) => new Promise<void>((r) => {
			i.addEventListener("load", () => r(), { once: true });
			i.addEventListener("error", () => r(), { once: true });
		}))).then(() => undefined),
		new Promise<void>((r) => window.setTimeout(r, timeout)),
	]);
}

/**
 * Auf das nächste Frame warten – mit Zeitlimit, denn in verdeckten/minimierten Fenstern
 * pausiert requestAnimationFrame (sonst hinge z. B. ein PDF-Export im Hintergrund).
 */
const frame = () =>
	new Promise<void>((r) => {
		const t = window.setTimeout(r, 100);
		requestAnimationFrame(() => { window.clearTimeout(t); r(); });
	});

export interface RenderedSlide {
	slide: HTMLElement;
	/** Markdown-Blöcke der Folie; Elemente tragen data-from/data-to (Index-Bereich der Blöcke) */
	chunks: Chunk[];
	/** Erneut einpassen (z. B. nach Bearbeitung) */
	refit: () => void;
}

/**
 * Rendert eine Folie in `host` (muss im DOM hängen, damit gemessen werden kann).
 */
export async function renderSlide(
	app: App,
	source: string,
	sourcePath: string,
	host: HTMLElement,
	component: Component,
	settings: FitSettings
): Promise<RenderedSlide> {
	const { flags } = extractFlags(source);
	const slide = host.createDiv({ cls: "sf-slide markdown-rendered" });
	slide.style.width = `${SLIDE_W}px`;
	slide.style.height = `${SLIDE_H}px`;
	if (flags.align) slide.dataset.align = flags.align;

	const staging = slide.createDiv({ cls: "sf-staging" });
	const chunks = splitChunks(source);
	// Jeder Block einzeln, damit jedes Element seinem Markdown zugeordnet werden kann
	for (let i = 0; i < chunks.length; i++) {
		const body = extractFlags(chunks[i].text).body;
		if (!body.trim()) continue;
		const tmp = staging.createDiv();
		await MarkdownRenderer.render(app, body, tmp, sourcePath, component);
		for (const el of topLevel(tmp)) {
			el.dataset.from = String(i);
			el.dataset.to = String(i);
			staging.insertBefore(el, tmp);
		}
		tmp.remove();
	}
	await frame();
	await waitForMedia(staging);

	const blocks = collectBlocks(staging, flags.caption !== "off" && flags.caption !== "aus");
	staging.remove();
	arrange(slide, blocks, normalizeLayout(flags.layout));

	const noFit = flags.fit === "off" || flags.fit === "aus";
	const refit = () => { if (!noFit) fitSlide(slide, settings); };
	refit();
	// Bilder, die später laden (z. B. Embeds), lösen ein erneutes Einpassen aus
	slide.querySelectorAll("img").forEach((img) => img.addEventListener("load", refit));
	await waitForMedia(slide);
	refit();
	return { slide, chunks, refit };
}
