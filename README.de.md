# ComfyUI Cast Library

Eine Bildbibliothek direkt in ComfyUI. **Personen** (jeweils mit den Bereichen Face und Body,
weitere Bereiche nach Bedarf), **Accessoires**, **Hintergründe** und beliebige eigene
Bibliotheken an einem Ort: Bild in der Galerie aussuchen, und es kommt als
**Bild + Maske** (optional skaliert) in den Workflow.

[English](README.md)

## Die Node: Cast Library · Load & Resize Image

| Element | Funktion |
| --- | --- |
| Auswahl Bibliothek / Bereich | Person oder Bibliothek und einen ihrer Bereiche (Ordner) wählen |
| 🖼 Gallery | Öffnet das Bibliotheksfenster: links alle Personen und Bibliotheken, rechts die Vorschaubilder. Ein Klick übernimmt das Bild |
| ⬆ | Bilder in den gewählten Bereich hochladen. Dateien können auch auf die Node oder in die Galerie gezogen werden |
| 📂 | Öffnet den gewählten Ordner im Explorer (zum Umbenennen und Löschen) |
| ＋ | Neue Person (mit den Bereichen *Face* und *Body*), neue Bibliothek oder neuer Bereich in der gewählten Bibliothek |
| resize, width, height, keep_proportion, divisible_by, upscale_method | Optionales Skalieren wie bei *Load & Resize Image + Filename* |
| mask_source | **MaskEditor**: die mit dem Button *Mask Editor* (oder Rechtsklick → Open in MaskEditor) gemalte Maske, gespeichert beim Bild in der Bibliothek; ohne Maske der Alphakanal des Bildes. **rectangle**: Rechteck in der Vorschau aufziehen. **freehand**: den zu behaltenden Bereich malen (Pinsel, Lasso, Radierer), außerhalb wird mit `fill_color` gefüllt |

**Maximale Größe:** Ist die längste Seite eines Bildes größer als 2048 px, skaliert die
Node Bild und Maske proportional herunter, sodass die längste Seite 2048 px hat (vor dem
optionalen Resize). Die Datei in der Bibliothek bleibt unverändert; die Infozeile über
der Vorschau zeigt die Ausgabegröße, z. B. `4000×3000 → 2048×1536`.

**Ausgänge:** `image`, `mask`, `width`, `height`, `filename` (ohne Endung),
`name` (Person oder Bibliothek, z. B. `Anna`), `area` (z. B. `Face`, leer beim
Hauptordner einer Bibliothek).

**Mit Farbe malen:** Im MaskEditor malt der Farbpinsel (zweites Werkzeug) mit einer
Volltonfarbe. Diese Farbe wird Teil des Ausgabebildes, in jedem `mask_source`-Modus,
und ist in der Vorschau der Node zu sehen. *Remove paint* entfernt sie wieder.

Masken und Farbe bleiben beim Bild und stehen in jedem Workflow (und zum
Weiterbearbeiten im MaskEditor) wieder zur Verfügung: die MaskEditor-Maske als
`<name>.mask.png`, die Farbe als `<name>.paint.png`, Rechteck oder Freihand-Form als
`<name>.shape.json`. Die Form wird zusätzlich im Workflow gespeichert. In der Galerie
zeigen die Markierungen **M**, **P** und **S**, was ein Bild hat.

## Wo die Bibliothek liegt

```
ComfyUI/user/cast_library/
├── Persons/
│   ├── Anna/
│   │   ├── Face/
│   │   └── Body/
│   └── Tom/ …
├── Accessories/
└── Backgrounds/
```

`Persons`, `Accessories` und `Backgrounds` werden beim ersten Start angelegt (englische Namen;
eigene Ordner dürfen natürlich deutsch heißen). Workflows speichern Pfade relativ zu diesem Ordner (z. B.
`Persons/Anna/Face/anna_01.png`). Sie funktionieren also weiter, wenn ComfyUI
verschoben oder neu installiert wird, solange der Ordner `user/cast_library`
mitkopiert wird.

Ordner, die du im Explorer anlegst, erscheinen ebenfalls: Unterordner einer Person
oder Bibliothek sind ihre Bereiche. Bilder direkt im Bibliotheksordner erscheinen als
Bereich *(main folder)*. Beim Umbenennen oder Löschen im Explorer die zugehörige
`.mask.png` und `.shape.json` mit umbenennen bzw. löschen. Der versteckte Ordner
`.thumbs` ist nur ein Vorschaubild-Cache und darf jederzeit gelöscht werden.

## Installation

In `ComfyUI/custom_nodes` klonen und ComfyUI neu starten:

```
cd ComfyUI/custom_nodes
git clone https://github.com/Slartibart23/ComfyUI-CastLibrary
```

Zusätzliche Python-Pakete sind nicht nötig.

## Hinweise

* Der 📂-Button öffnet den Explorer auf dem Rechner, auf dem ComfyUI läuft.
* Der MaskEditor liest Bilder nur aus den input-, output- und temp-Ordnern von
  ComfyUI. Die Node gibt ihm deshalb Arbeitskopien (in `input/cast_library`, nach
  zwei Tagen aufgeräumt) und macht nach *Save* daraus die `<name>.mask.png` und
  die `<name>.paint.png`.
* Getestet mit ComfyUI 0.41 und Frontend 1.55.

## Lizenz

GPL-3.0. Die Skalier- und Maskenlogik stammt aus *Load & Resize Image + Filename*,
das auf [KJNodes](https://github.com/kijai/ComfyUI-KJNodes) LoadAndResizeImage von
kijai basiert.
