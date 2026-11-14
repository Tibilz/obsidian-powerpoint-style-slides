import { Component, Notice, TFile, normalizePath } from "obsidian";
import type PowerPointStyleSlidesPlugin from "./main";
import { parseDeck } from "./parser";
import { renderSlide } from "./slide";
import { electronRemote } from "./electron";

const isBlank = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").trim() === "";

export async function exportPdf(plugin: PowerPointStyleSlidesPlugin, file: TFile) {
	const { app } = plugin;
	const deck = parseDeck(await app.vault.read(file));
	const sources = deck.slides.filter((s) => !isBlank(s));
	if (!sources.length) { new Notice("Die Notiz enthält keine Folien."); return; }

	const notice = new Notice(`PDF wird erstellt … (0/${sources.length})`, 0);
	const root = document.body.createDiv({ cls: "sf-print-root" });
	const component = new Component();
	component.load();
	try {
		for (let i = 0; i < sources.length; i++) {
			const page = root.createDiv({ cls: "sf-print-page" });
			await renderSlide(app, sources[i], file.path, page, component, plugin.settings);
			notice.setMessage(`PDF wird erstellt … (${i + 1}/${sources.length})`);
		}
		document.body.addClass("sf-printing");
		// @page nur während des Exports, damit Obsidians eigener PDF-Export unberührt bleibt
		const pageStyle = document.head.createEl("style", { text: "@page { size: 1280px 720px; margin: 0; }" });
		component.register(() => pageStyle.remove());
		const pdf = await printToPdf();
		if (pdf) {
			const target = await saveTarget(plugin, file);
			if (target) {
				if (target.external) {
					(window as any).require("fs").writeFileSync(target.path, pdf);
				} else {
					const buf = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
					const existing = app.vault.getAbstractFileByPath(target.path);
					if (existing instanceof TFile) await app.vault.modifyBinary(existing, buf);
					else await app.vault.createBinary(target.path, buf);
				}
				new Notice(`PDF gespeichert: ${target.path}`);
			}
		} else {
			// Fallback: System-Druckdialog → "Als PDF sichern"
			await new Promise<void>((resolve) => {
				window.addEventListener("afterprint", () => resolve(), { once: true });
				window.print();
				window.setTimeout(resolve, 120000);
			});
		}
	} catch (e) {
		console.error("[powerpoint-style-slides] PDF-Export fehlgeschlagen", e);
		new Notice(`PDF-Export fehlgeschlagen: ${(e as Error).message}`);
	} finally {
		notice.hide();
		document.body.removeClass("sf-printing");
		component.unload();
		root.remove();
	}
}

async function printToPdf(): Promise<Uint8Array | null> {
	const remote = electronRemote();
	const wc = remote?.getCurrentWebContents?.();
	if (!wc?.printToPDF) return null;
	const base = { printBackground: true, preferCSSPageSize: true };
	try {
		return await wc.printToPDF({ ...base, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
	} catch {
		return await wc.printToPDF({ ...base, marginsType: 1 });
	}
}

async function saveTarget(plugin: PowerPointStyleSlidesPlugin, file: TFile): Promise<{ path: string; external: boolean } | null> {
	const name = `${file.basename}.pdf`;
	const remote = electronRemote();
	const adapter = plugin.app.vault.adapter as any;
	if (plugin.settings.askForPdfLocation && remote?.dialog && adapter.getFullPath) {
		const res = await remote.dialog.showSaveDialog(remote.getCurrentWindow(), {
			title: "Präsentation als PDF speichern",
			defaultPath: adapter.getFullPath(normalizePath(`${file.parent?.path ?? ""}/${name}`)),
			filters: [{ name: "PDF", extensions: ["pdf"] }],
		});
		if (res.canceled || !res.filePath) return null;
		return { path: res.filePath, external: true };
	}
	const dir = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
	return { path: normalizePath(dir + name), external: false };
}
