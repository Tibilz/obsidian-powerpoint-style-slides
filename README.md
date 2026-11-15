# PowerPoint-style Slides

Present Obsidian notes as slides – like the built-in Slides core plugin (slides are separated by `---`), but:

- **Nothing gets cropped:** overfull slides are scaled down automatically.
- **Automatic PowerPoint-like layouts:** bullet points left, image right, code in the middle – overridable per slide with flags.
- **Image captions**, **zoom**, **laser pointer**, **pen (temporary drawings)**, **in-slide editing** (changes are written back to the note) and **PDF export** (one slide per page, 16:9).

Desktop only. The UI is currently German.

---

## Deutsch

Präsentiert eine Notiz (Folien getrennt durch `---`) im PowerPoint-Stil.

## Befehle
- **Präsentation starten (von Anfang)** / **ab aktueller Folie** (auch über das Ribbon-Icon und das Datei-Kontextmenü „Folien präsentieren“)
- **Als PDF exportieren**: eine Folie pro Seite, 16:9, gleiches Layout wie beim Präsentieren

## Automatisches Layout
| Inhalt der Folie | Anordnung |
|---|---|
| `# Überschrift` + kurzer Text | Titelfolie |
| Stichpunkte + Bild | Text links, Bild rechts |
| Stichpunkte + Code + Bild | Text · Code (Mitte) · Bild |
| Text + Code | Text oben, Code darunter |
| nur Bild(er) | groß bzw. als Raster |

Die erste Überschrift einer Folie wird zur Folien-Überschrift. Passt der Inhalt nicht, wird er verkleinert. Abgeschnitten wird nichts.

## Flags (pro Folie, irgendwo in der Folie)
```
<!-- layout: bild-links -->
```
`layout`: `auto`, `titel`, `text`, `zentriert`, `bild-links`, `bild-rechts`, `bild-oben`, `bild-unten`, `bild-voll`
Weitere Flags: `caption: aus` (keine Bildunterschriften), `fit: aus` (nicht verkleinern), `align: center`.
Mehrere Flags in einem Kommentar: `<!-- layout: bild-links; align: center -->`

## Bildunterschrift
Eine kursive Zeile direkt unter dem Bild:
```
![[diagramm.png]]
*Abb. 1: Umsatz 2025*
```

## Steuerung im Präsentationsmodus
| Taste | Aktion |
|---|---|
| → ↓ Leertaste Enter / Klick rechts | weiter |
| ← ↑ / Klick links | zurück |
| Pinch / Cmd+Scroll, Doppelklick, `+` `-` | zoomen |
| Ziehen / Scrollen (gezoomt) | verschieben |
| `0` | Zoom zurücksetzen |
| `L` oder Fadenkreuz oben rechts | Laserpointer an/aus |
| `D` oder Stift oben rechts | Zeichnen (schwarz) – nur während dieser Präsentation sichtbar, nichts wird gespeichert |
| Cmd+Z / `C` | letzten Strich rückgängig / Zeichnungen der Folie löschen |
| `E` oder Schloss oben rechts | Direkt in der Folie bearbeiten (wird live in die Notiz gespeichert) |
| Esc | Bearbeiten beenden → Zoom zurück → Laser/Stift aus → Präsentation beenden |

## Bearbeiten in der Folie
Bei offenem Schloss tippst du direkt in den formatierten Text (Cmd+B / Cmd+I für fett/kursiv).
Jeder Block wird einzeln zurückgeschrieben; nicht angefasste Blöcke bleiben Zeichen für Zeichen gleich.
Blöcke, die nicht verlustfrei als formatierter Text bearbeitet werden können (Bilder, Formeln,
Callouts, Fußnoten …), sind gestrichelt umrandet: Ein Klick zeigt dort ihr Markdown direkt in der Folie.

## Entwickeln
```
npm install
npm run build   # erzeugt main.js
npm test        # Parser-Tests
```
Installieren: `main.js`, `manifest.json`, `styles.css` nach `<Vault>/.obsidian/plugins/powerpoint-style-slides/` kopieren und in den Einstellungen unter „Community-Plugins“ aktivieren.

## Veröffentlichen
```
npm version patch   # erhöht Version in package.json, manifest.json, versions.json und legt einen Tag an
git push --follow-tags
```
Die GitHub-Action baut das Plugin und legt ein Release-Entwurf mit `main.js`, `manifest.json`, `styles.css` an.
