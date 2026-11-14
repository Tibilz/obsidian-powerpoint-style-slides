import { Component, Notice, TFile, setIcon, debounce } from "obsidian";
import type PowerPointStyleSlidesPlugin from "./main";
import { Deck, joinChunks, parseDeck, serializeDeck } from "./parser";
import { renderSlide, RenderedSlide, SLIDE_H, SLIDE_W } from "./slide";
import { blockToMd, canEditWysiwyg } from "./wysiwyg";

const isBlank = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").trim() === "";

/** Zusammenhängende Elemente, die einen Bereich von Markdown-Blöcken darstellen */
interface Unit {
	from: number;
	to: number;
	els: HTMLElement[];
}

export class Presenter {
	private root!: HTMLElement;
	private stage!: HTMLElement;
	private viewport!: HTMLElement;
	private zoomEl!: HTMLElement;
	private scaler!: HTMLElement;
	private counter!: HTMLElement;
	private lockBtn!: HTMLElement;
	private laserBtn!: HTMLElement;
	private laserCanvas!: HTMLCanvasElement;

	private deck!: Deck;
	/** Indizes der nicht-leeren Folien in deck.slides */
	private visible: number[] = [];
	private pos = 0;
	private component = new Component();
	private currentChild: Component | null = null;
	private current: RenderedSlide | null = null;
	private renderToken = 0;
	private ownWrite = false;

	private editing = false;
	private dirty = false;
	private saveSoon = debounce(() => this.save(), 500, true);

	private laser = false;
	private trail: { x: number; y: number; t: number }[] = [];
	private laserVisible = false;
	private laserFrame = 0;

	private zoom = 1;
	private tx = 0;
	private ty = 0;
	private fitScale = 1;
	private cleanup: (() => void)[] = [];

	constructor(private plugin: PowerPointStyleSlidesPlugin, private file: TFile) {}

	async open(startSlide: number) {
		this.loadDeck(await this.plugin.app.vault.read(this.file));
		if (!this.visible.length) { new Notice("Die Notiz enthält keine Folien."); return; }
		const p = this.visible.findIndex((i) => i >= startSlide);
		this.pos = p === -1 ? 0 : p;
		this.buildDom();
		this.component.load();
		this.enterFullScreen();
		await this.show();
	}

	private loadDeck(text: string) {
		this.deck = parseDeck(text);
		this.visible = this.deck.slides.map((s, i) => (isBlank(s) ? -1 : i)).filter((i) => i >= 0);
		if (this.pos >= this.visible.length) this.pos = Math.max(0, this.visible.length - 1);
	}

	private buildDom() {
		this.root = document.body.createDiv({ cls: "sf-presenter" });
		this.root.tabIndex = -1;
		this.stage = this.root.createDiv({ cls: "sf-stage" });
		this.viewport = this.stage.createDiv({ cls: "sf-viewport" });
		this.zoomEl = this.viewport.createDiv({ cls: "sf-zoom" });
		this.scaler = this.zoomEl.createDiv({ cls: "sf-scaler" });
		this.laserCanvas = this.stage.createEl("canvas", { cls: "sf-laser" });

		const bar = this.root.createDiv({ cls: "sf-bar" });
		const btn = (parent: HTMLElement, cls: string, icon: string, title: string, fn: () => void) => {
			const b = parent.createDiv({ cls, attr: { "aria-label": title } });
			setIcon(b, icon);
			b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
			b.addEventListener("pointerdown", (e) => e.stopPropagation());
			return b;
		};
		btn(bar, "sf-btn", "chevron-left", "Zurück", () => this.go(this.pos - 1));
		this.counter = bar.createDiv({ cls: "sf-counter" });
		btn(bar, "sf-btn", "chevron-right", "Weiter", () => this.go(this.pos + 1));
		btn(bar, "sf-btn", "zoom-out", "Zoom zurücksetzen (0)", () => this.resetZoom());
		btn(bar, "sf-btn", "x", "Beenden (Esc)", () => this.close());

		const tools = this.root.createDiv({ cls: "sf-tools" });
		this.laserBtn = btn(tools, "sf-tool", "crosshair", "Laserpointer (L)", () => this.toggleLaser());
		this.lockBtn = btn(tools, "sf-tool", "lock", "Bearbeiten entsperren (E)", () => this.toggleEdit());

		this.listen(window, "keydown", (e) => this.onKey(e as KeyboardEvent), true);
		this.listen(window, "resize", () => this.layoutStage());
		this.listen(this.viewport, "wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
		this.listen(this.viewport, "dblclick", (e) => this.onDblClick(e as MouseEvent));
		this.setupPointer();

		const ro = new ResizeObserver(() => this.layoutStage());
		ro.observe(this.viewport);
		this.cleanup.push(() => ro.disconnect());

		// Änderungen an der Datei von außen (z. B. im Editor) übernehmen
		const ref = this.plugin.app.vault.on("modify", async (f) => {
			if (f !== this.file || this.ownWrite) return;
			this.loadDeck(await this.plugin.app.vault.read(this.file));
			if (!this.editing) await this.show();
		});
		this.cleanup.push(() => this.plugin.app.vault.offref(ref));
		this.root.focus();
	}

	private listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions) {
		target.addEventListener(type, fn, opts);
		this.cleanup.push(() => target.removeEventListener(type, fn, opts));
	}

	private get slideIndex() { return this.visible[this.pos]; }

	private async show() {
		const token = ++this.renderToken;
		this.counter.setText(`${this.pos + 1} / ${this.visible.length}`);
		const child = new Component();
		const host = createDiv({ cls: "sf-render-host" });
		// Zum Messen unsichtbar, aber mit echtem Layout rendern
		host.style.visibility = "hidden";
		this.scaler.appendChild(host);
		this.component.addChild(child);
		const rendered = await renderSlide(this.plugin.app, this.deck.slides[this.slideIndex], this.file.path, host, child, this.plugin.settings);
		if (token !== this.renderToken) { host.remove(); this.component.removeChild(child); return; }
		Array.from(this.scaler.children).forEach((c) => { if (c !== host) c.remove(); });
		if (this.currentChild) this.component.removeChild(this.currentChild);
		this.currentChild = child;
		this.current = rendered;
		host.style.visibility = "";
		if (this.editing) this.makeEditable();
		this.layoutStage();
	}

	private layoutStage() {
		if (!this.viewport) return;
		const w = this.viewport.clientWidth;
		const h = this.viewport.clientHeight;
		this.fitScale = Math.min(w / SLIDE_W, h / SLIDE_H);
		this.scaler.style.width = `${SLIDE_W * this.fitScale}px`;
		this.scaler.style.height = `${SLIDE_H * this.fitScale}px`;
		this.scaler.style.setProperty("--sf-fit", String(this.fitScale));
		const dpr = window.devicePixelRatio || 1;
		this.laserCanvas.width = this.stage.clientWidth * dpr;
		this.laserCanvas.height = this.stage.clientHeight * dpr;
		this.applyZoom();
	}

	private async go(p: number) {
		if (p < 0 || p >= this.visible.length || p === this.pos) return;
		await this.flush();
		this.pos = p;
		this.resetZoom();
		await this.show();
	}

	// ---------- Zoom ----------

	private applyZoom() {
		this.zoomEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
		this.root.toggleClass("sf-zoomed", this.zoom > 1.001);
	}

	private zoomAt(factor: number, cx: number, cy: number) {
		const r = this.viewport.getBoundingClientRect();
		const px = cx - r.left;
		const py = cy - r.top;
		const next = Math.min(8, Math.max(1, this.zoom * factor));
		const k = next / this.zoom;
		this.tx = px - (px - this.tx) * k;
		this.ty = py - (py - this.ty) * k;
		this.zoom = next;
		if (next === 1) { this.tx = 0; this.ty = 0; }
		this.clampPan();
		this.applyZoom();
	}

	private clampPan() {
		const w = this.viewport.clientWidth;
		const h = this.viewport.clientHeight;
		this.tx = Math.min(0, Math.max(w - w * this.zoom, this.tx));
		this.ty = Math.min(0, Math.max(h - h * this.zoom, this.ty));
	}

	private resetZoom() { this.zoom = 1; this.tx = 0; this.ty = 0; if (this.zoomEl) this.applyZoom(); }

	private zoomAtCenter(f: number) {
		const r = this.viewport.getBoundingClientRect();
		this.zoomAt(f, r.left + r.width / 2, r.top + r.height / 2);
	}

	private onWheel(e: WheelEvent) {
		if (e.ctrlKey || e.metaKey) {
			// Trackpad-Pinch kommt als ctrl+wheel
			e.preventDefault();
			this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
		} else if (this.zoom > 1) {
			e.preventDefault();
			this.tx -= e.deltaX; this.ty -= e.deltaY;
			this.clampPan(); this.applyZoom();
		}
	}

	private onDblClick(e: MouseEvent) {
		if (this.editing) return;
		if (this.zoom > 1) this.resetZoom();
		else this.zoomAt(2.5, e.clientX, e.clientY);
	}

	private setupPointer() {
		let drag: { x: number; y: number; tx: number; ty: number } | null = null;
		let moved = false;
		this.listen(this.viewport, "pointerdown", (ev) => {
			const e = ev as PointerEvent;
			if (e.button !== 0 || this.editing) return;
			drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
			moved = false;
		});
		this.listen(window, "pointermove", (ev) => {
			const e = ev as PointerEvent;
			if (this.laser) this.laserMove(e);
			if (!drag || this.zoom <= 1) return;
			if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) moved = true;
			this.tx = drag.tx + e.clientX - drag.x;
			this.ty = drag.ty + e.clientY - drag.y;
			this.clampPan(); this.applyZoom();
		});
		this.listen(window, "pointerup", () => { drag = null; });
		this.listen(this.stage, "pointerleave", () => { this.laserVisible = false; });
		this.listen(this.viewport, "click", (ev) => {
			const e = ev as MouseEvent;
			if (this.editing || this.laser || moved || this.zoom > 1) return;
			if ((e.target as HTMLElement).closest("a")) return;
			// Klick rechts = weiter, links = zurück (wie im Standard-Präsentationsmodus)
			const r = this.viewport.getBoundingClientRect();
			if (e.clientX - r.left > r.width / 3) this.go(this.pos + 1); else this.go(this.pos - 1);
		});
	}

	// ---------- Laserpointer ----------

	private toggleLaser(force?: boolean) {
		const on = force ?? !this.laser;
		if (on === this.laser) return;
		if (on && this.editing) void this.toggleEdit(false);
		this.laser = on;
		this.root.toggleClass("sf-laser-on", on);
		this.laserBtn.toggleClass("is-active", on);
		this.trail = [];
		this.laserVisible = false;
		if (on) this.laserFrame = requestAnimationFrame(() => this.drawLaser());
		else { cancelAnimationFrame(this.laserFrame); this.clearLaser(); }
	}

	private laserMove(e: PointerEvent) {
		const r = this.stage.getBoundingClientRect();
		const x = e.clientX - r.left;
		const y = e.clientY - r.top;
		this.laserVisible = x >= 0 && y >= 0 && x <= r.width && y <= r.height;
		this.trail.push({ x, y, t: performance.now() });
		this.lastLaser = { x, y };
	}

	private clearLaser() {
		const ctx = this.laserCanvas.getContext("2d");
		ctx?.clearRect(0, 0, this.laserCanvas.width, this.laserCanvas.height);
	}

	private drawLaser() {
		if (!this.laser) return;
		const ctx = this.laserCanvas.getContext("2d");
		const dpr = window.devicePixelRatio || 1;
		const now = performance.now();
		const LIFE = 350;
		this.trail = this.trail.filter((p) => now - p.t < LIFE);
		if (ctx) {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, this.laserCanvas.width, this.laserCanvas.height);
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			for (let i = 1; i < this.trail.length; i++) {
				const a = this.trail[i - 1];
				const b = this.trail[i];
				const life = 1 - (now - b.t) / LIFE;
				ctx.strokeStyle = `rgba(255, 40, 40, ${0.55 * life})`;
				ctx.lineWidth = 2 + 6 * life;
				ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
			}
			const last = this.lastLaser;
			if (last && this.laserVisible) {
				const g = ctx.createRadialGradient(last.x, last.y, 0, last.x, last.y, 18);
				g.addColorStop(0, "rgba(255, 255, 255, 1)");
				g.addColorStop(0.18, "rgba(255, 50, 50, 1)");
				g.addColorStop(0.45, "rgba(255, 0, 0, 0.45)");
				g.addColorStop(1, "rgba(255, 0, 0, 0)");
				ctx.fillStyle = g;
				ctx.beginPath(); ctx.arc(last.x, last.y, 18, 0, Math.PI * 2); ctx.fill();
			}
		}
		this.laserFrame = requestAnimationFrame(() => this.drawLaser());
	}
	private lastLaser: { x: number; y: number } | null = null;

	// ---------- Bearbeiten direkt in der Folie ----------

	private async toggleEdit(force?: boolean) {
		const on = force ?? !this.editing;
		if (on === this.editing) return;
		if (on && this.laser) this.toggleLaser(false);
		this.editing = on;
		this.root.toggleClass("sf-editing", on);
		setIcon(this.lockBtn, on ? "lock-open" : "lock");
		this.lockBtn.toggleClass("is-active", on);
		this.lockBtn.setAttr("aria-label", on ? "Sperren (Esc)" : "Bearbeiten entsperren (E)");
		if (on) {
			this.resetZoom();
			this.makeEditable();
		} else {
			await this.flush();
			this.root.focus();
			await this.show(); // sauber neu rendern
		}
	}

	/** Elemente der aktuellen Folie nach Markdown-Blockbereich gruppieren */
	private units(): Unit[] {
		const slide = this.current?.slide;
		if (!slide) return [];
		const map = new Map<string, Unit>();
		slide.querySelectorAll<HTMLElement>("[data-from]").forEach((el) => {
			if (el.parentElement?.closest("[data-from]")) return;
			const from = Number(el.dataset.from);
			const to = Number(el.dataset.to);
			const key = `${from}-${to}`;
			if (!map.has(key)) map.set(key, { from, to, els: [] });
			map.get(key)!.els.push(el);
		});
		return Array.from(map.values()).sort((a, b) => a.from - b.from);
	}

	private unitSource(u: Unit): string {
		const chunks = this.current!.chunks;
		let s = "";
		for (let i = u.from; i <= u.to; i++) s += chunks[i].text + (i < u.to ? chunks[i].gap : "");
		return s;
	}

	private setUnitSource(u: Unit, md: string) {
		const chunks = this.current!.chunks;
		const nl = chunks[u.to].text.match(/\r?\n$/)?.[0] ?? "";
		chunks[u.from].text = md.replace(/\s+$/, "") + nl;
		if (u.to > u.from) {
			// Mehrere Blöcke (z. B. Bild + Bildunterschrift) werden zu einem zusammengefasst
			chunks[u.from].gap = chunks[u.to].gap;
			for (let i = u.from + 1; i <= u.to; i++) { chunks[i].text = ""; chunks[i].gap = ""; }
			u.to = u.from;
		}
		this.deck.slides[this.slideIndex] = joinChunks(chunks);
		this.dirty = true;
		this.saveSoon();
	}

	private makeEditable() {
		const cur = this.current;
		if (!cur) return;
		for (const u of this.units()) {
			const src = this.unitSource(u);
			const first = u.els[0];
			const code = u.els.length === 1 && first.tagName === "PRE" ? first.querySelector("code") : null;

			if (code) {
				// Code: Klartext direkt bearbeiten, Code-Zaun bleibt erhalten
				const lines = src.replace(/\r?\n$/, "").split("\n");
				const open = lines[0];
				const close = lines.length > 1 && /^\s*[`~]{3,}\s*$/.test(lines[lines.length - 1]) ? lines[lines.length - 1] : open.match(/^\s*([`~]{3,})/)?.[1] ?? "```";
				code.contentEditable = "plaintext-only";
				code.addClass("sf-editable");
				code.addEventListener("input", () => {
					this.setUnitSource(u, `${open}\n${(code.textContent ?? "").replace(/\n$/, "")}\n${close}`);
					cur.refit();
				});
			} else if (canEditWysiwyg(u.els, src)) {
				for (const el of u.els) {
					el.contentEditable = "true";
					el.addClass("sf-editable");
					el.addEventListener("input", () => {
						try {
							this.setUnitSource(u, u.els.map(blockToMd).join("\n"));
						} catch {
							new Notice("Diese Formatierung kann nicht gespeichert werden.");
						}
						cur.refit();
					});
					el.addEventListener("paste", (e) => {
						// Nur Text einfügen, keine fremde Formatierung
						e.preventDefault();
						const text = e.clipboardData?.getData("text/plain") ?? "";
						insertAtCaret(document.createTextNode(text));
					});
				}
			} else {
				// Nicht sicher als WYSIWYG zurückzuschreiben → Markdown direkt an Ort und Stelle
				for (const el of u.els) {
					el.addClass("sf-editable-raw");
					el.setAttr("aria-label", "Klicken, um als Markdown zu bearbeiten");
					el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.openRaw(u); }, { once: true });
				}
			}
		}
	}

	private openRaw(u: Unit) {
		const first = u.els[0];
		const ta = createEl("textarea", { cls: "sf-raw-editor" });
		ta.value = this.unitSource(u).replace(/\r?\n$/, "");
		ta.spellcheck = false;
		first.parentElement!.insertBefore(ta, first);
		u.els.forEach((el) => (el.style.display = "none"));
		// Höhe über Zeilenanzahl (in em) statt Pixel, damit das Feld beim Einpassen mitschrumpft
		const grow = () => { ta.rows = Math.max(2, ta.value.split("\n").length); this.current?.refit(); };
		ta.addEventListener("input", () => { this.setUnitSource(u, ta.value); grow(); });
		ta.addEventListener("blur", async () => {
			await this.flush();
			if (this.editing) await this.show();
		});
		grow();
		ta.focus();
	}

	/** Ausstehende Änderungen sofort speichern */
	private async flush() {
		if (this.dirty) await this.save();
	}

	private async save() {
		if (!this.dirty) return;
		this.dirty = false;
		const idx = this.slideIndex;
		const text = this.deck.slides[idx];
		const expectedCount = this.deck.slides.length;
		this.ownWrite = true;
		try {
			await this.plugin.app.vault.process(this.file, (data) => {
				const d = parseDeck(data);
				if (d.slides.length !== expectedCount) {
					new Notice("Die Notiz wurde inzwischen anders aufgeteilt – Änderung nicht gespeichert.");
					return data;
				}
				d.slides[idx] = text;
				return serializeDeck(d);
			});
		} finally {
			window.setTimeout(() => { this.ownWrite = false; }, 150);
		}
		// Neue Trenner (---) in der Folie → Folien neu aufteilen
		if (/^---[ \t]*$/m.test(text) || isBlank(text)) {
			this.loadDeck(await this.plugin.app.vault.read(this.file));
		}
	}

	// ---------- Tastatur & Fenster ----------

	private onKey(e: KeyboardEvent) {
		const k = e.key;
		const handled = () => { e.preventDefault(); e.stopPropagation(); };
		if (this.editing) {
			if (k === "Escape") { handled(); void this.toggleEdit(false); return; }
			const typing = (e.target as HTMLElement)?.closest?.<HTMLElement>("[contenteditable], textarea");
			if (typing) {
				// Tasten gehören dem Text; Obsidian-Hotkeys nicht auslösen
				e.stopPropagation();
				// Enter in Absatz/Überschrift = Zeilenumbruch (Listen erzeugen nativ einen neuen Punkt)
				if (k === "Enter" && !e.shiftKey && typing.isContentEditable && typing.contentEditable === "true" && !/^(UL|OL)$/.test(typing.tagName)) {
					e.preventDefault();
					insertAtCaret(document.createElement("br"), typing);
				}
				return;
			}
		}
		if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].includes(k)) { handled(); this.go(this.pos + 1); }
		else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].includes(k)) { handled(); this.go(this.pos - 1); }
		else if (k === "Home") { handled(); this.go(0); }
		else if (k === "End") { handled(); this.go(this.visible.length - 1); }
		else if (k === "e" || k === "E") { handled(); void this.toggleEdit(); }
		else if (k === "l" || k === "L") { handled(); this.toggleLaser(); }
		else if (k === "+" || k === "=") { handled(); this.zoomAtCenter(1.25); }
		else if (k === "-") { handled(); this.zoomAtCenter(0.8); }
		else if (k === "0") { handled(); this.resetZoom(); }
		else if (k === "Escape") {
			handled();
			if (this.zoom > 1) this.resetZoom();
			else if (this.laser) this.toggleLaser(false);
			else this.close();
		} else if (!e.metaKey && !e.ctrlKey) {
			// Obsidian-Hotkeys im Hintergrund nicht auslösen
			e.stopPropagation();
		}
	}

	private enterFullScreen() {
		// Standard-Fullscreen-API; Keyboard Lock sorgt dafür, dass Esc bei uns ankommt
		// (statt sofort den Vollbildmodus zu beenden). Gedrückt halten beendet ihn trotzdem.
		this.root.requestFullscreen?.()
			.then(() => (navigator as any).keyboard?.lock?.(["Escape"]))
			.catch(() => { /* Vollbild nicht verfügbar – Overlay deckt das Fenster trotzdem ab */ });
	}

	async close() {
		if (!this.root) return;
		await this.flush();
		this.laser = false;
		cancelAnimationFrame(this.laserFrame);
		this.cleanup.forEach((f) => f());
		this.cleanup = [];
		this.component.unload();
		this.root.remove();
		(navigator as any).keyboard?.unlock?.();
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
		this.plugin.presenter = null;
	}
}

/** Fügt einen Knoten an der Cursorposition ein und setzt den Cursor dahinter. */
function insertAtCaret(node: Node, host?: HTMLElement) {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return;
	const range = sel.getRangeAt(0);
	range.deleteContents();
	range.insertNode(node);
	// Ein <br> ganz am Ende eines Blocks ist unsichtbar – ein zweites macht die neue Zeile sichtbar
	if (node.nodeName === "BR" && host && !node.nextSibling) host.appendChild(document.createElement("br"));
	range.setStartAfter(node);
	range.collapse(true);
	sel.removeAllRanges();
	sel.addRange(range);
	node.parentElement?.closest("[contenteditable]")?.dispatchEvent(new Event("input", { bubbles: true }));
}
