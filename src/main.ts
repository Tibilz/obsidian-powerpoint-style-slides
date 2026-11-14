import { App, MarkdownView, Plugin, PluginSettingTab, Setting, TFile, Notice } from "obsidian";
import { Presenter } from "./presenter";
import { exportPdf } from "./pdf";
import { parseDeck, slideIndexAtLine } from "./parser";

export interface SlidesSettings {
	baseFontSize: number;
	minFontSize: number;
	askForPdfLocation: boolean;
}

const DEFAULTS: SlidesSettings = { baseFontSize: 30, minFontSize: 14, askForPdfLocation: true };

export default class PowerPointStyleSlidesPlugin extends Plugin {
	settings!: SlidesSettings;
	presenter: Presenter | null = null;

	async onload() {
		this.settings = Object.assign({}, DEFAULTS, await this.loadData());

		this.addRibbonIcon("presentation", "Folien präsentieren", () => this.present(false));

		this.addCommand({
			id: "present-from-start",
			name: "Präsentation starten (von Anfang)",
			checkCallback: (check) => this.withFile(check, () => this.present(false)),
		});
		this.addCommand({
			id: "present-from-cursor",
			name: "Präsentation ab aktueller Folie starten",
			checkCallback: (check) => this.withFile(check, () => this.present(true)),
		});
		this.addCommand({
			id: "export-pdf",
			name: "Als PDF exportieren",
			checkCallback: (check) => this.withFile(check, (f) => exportPdf(this, f)),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((i) => i.setTitle("Folien präsentieren").setIcon("presentation").onClick(() => this.startPresenter(file, 0)));
				menu.addItem((i) => i.setTitle("Folien als PDF exportieren").setIcon("file-down").onClick(() => exportPdf(this, file)));
			})
		);

		this.addSettingTab(new SlidesSettingTab(this.app, this));
	}

	onunload() {
		this.presenter?.close();
	}

	private activeFile(): TFile | null {
		const f = this.app.workspace.getActiveFile();
		return f && f.extension === "md" ? f : null;
	}

	private withFile(check: boolean, run: (f: TFile) => unknown): boolean {
		const f = this.activeFile();
		if (!f) return false;
		if (!check) run(f);
		return true;
	}

	private async present(fromCursor: boolean) {
		const file = this.activeFile();
		if (!file) { new Notice("Öffne zuerst eine Notiz."); return; }
		let start = 0;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (fromCursor && view?.editor) {
			start = slideIndexAtLine(parseDeck(view.editor.getValue()), view.editor.getCursor().line);
		}
		await this.startPresenter(file, start);
	}

	async startPresenter(file: TFile, start: number) {
		this.presenter?.close();
		this.presenter = new Presenter(this, file);
		await this.presenter.open(start);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SlidesSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PowerPointStyleSlidesPlugin) { super(app, plugin); }

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const num = (name: string, desc: string, key: "baseFontSize" | "minFontSize", min: number, max: number) =>
			new Setting(containerEl).setName(name).setDesc(desc).addSlider((s) =>
				s.setLimits(min, max, 1).setValue(this.plugin.settings[key]).setDynamicTooltip().onChange(async (v) => {
					this.plugin.settings[key] = v;
					await this.plugin.saveSettings();
				})
			);
		num("Normale Schriftgröße", "Schriftgröße auf einer Folie, wenn alles hineinpasst (Folie ist 1280 × 720).", "baseFontSize", 16, 48);
		num("Bevorzugte Mindestgröße", "Bis hierhin wird verkleinert. Passt es dann immer noch nicht, wird trotzdem weiter verkleinert – abgeschnitten wird nie.", "minFontSize", 6, 30);
		new Setting(containerEl)
			.setName("Speicherort für PDF erfragen")
			.setDesc("Aus: Das PDF wird neben der Notiz im Vault gespeichert.")
			.addToggle((t) => t.setValue(this.plugin.settings.askForPdfLocation).onChange(async (v) => {
				this.plugin.settings.askForPdfLocation = v;
				await this.plugin.saveSettings();
			}));

		this.renderFlagReference(containerEl);
	}

	private renderFlagReference(containerEl: HTMLElement) {
		new Setting(containerEl).setName("Flags").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Flags schreibst du irgendwo in eine Folie (zwischen zwei ---). Sie sind in der normalen Notiz unsichtbar. " +
				"Mehrere Flags kannst du mit ; trennen, z. B. <!-- layout: bild-links; align: center -->.",
		});

		const flags: { code: string; desc: string }[] = [
			{ code: "<!-- layout: auto -->", desc: "Standard: Das Plugin wählt das Layout anhand des Inhalts." },
			{ code: "<!-- layout: titel -->", desc: "Titelfolie: alles groß und zentriert." },
			{ code: "<!-- layout: text -->", desc: "Alles untereinander in einer Spalte, in der Reihenfolge der Notiz." },
			{ code: "<!-- layout: zentriert -->", desc: "Eine Spalte, horizontal und vertikal zentriert." },
			{ code: "<!-- layout: bild-links -->", desc: "Bilder links, Text und Code rechts." },
			{ code: "<!-- layout: bild-rechts -->", desc: "Text und Code links, Bilder rechts." },
			{ code: "<!-- layout: bild-oben -->", desc: "Bilder oben, Text darunter." },
			{ code: "<!-- layout: bild-unten -->", desc: "Text oben, Bilder darunter." },
			{ code: "<!-- layout: bild-voll -->", desc: "Bilder so groß wie möglich, übriger Inhalt darunter." },
			{ code: "<!-- caption: aus -->", desc: "Kursive Zeilen unter Bildern nicht als Bildunterschrift verwenden." },
			{ code: "<!-- fit: aus -->", desc: "Folie nicht automatisch verkleinern (Inhalt kann dann abgeschnitten werden)." },
			{ code: "<!-- align: center -->", desc: "Text auf der Folie zentrieren." },
		];

		for (const f of flags) {
			const s = new Setting(containerEl).setDesc(f.desc);
			s.nameEl.createEl("code", { text: f.code });
			s.addExtraButton((b) =>
				b.setIcon("copy").setTooltip("Kopieren").onClick(async () => {
					await navigator.clipboard.writeText(f.code);
					new Notice(`Kopiert: ${f.code}`);
				})
			);
		}

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Englische Varianten funktionieren auch: title, center, image-left, image-right, image-top, image-bottom, image-full, off.",
		});
	}
}
