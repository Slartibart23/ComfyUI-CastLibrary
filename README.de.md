# ComfyUI Cast Library

Eine Bildbibliothek direkt in ComfyUI. Personen, Hintergründe, Accessoires, Kleidung und
alles andere liegen in deinem eigenen Ordnerbaum, den du in der Node verwaltest. Bild in
der Galerie aussuchen, und es kommt als **Bild + Maske** (optional zugeschnitten und
skaliert) in den Workflow.

[English](README.md)

## Die Node: Cast Library · Load & Resize Image

| Element | Funktion |
| --- | --- |
| Ordner-Auswahl | Der Ordner für Galerie und Upload |
| 🖼 Gallery | Öffnet das Bibliotheksfenster (siehe unten). Ein Klick übernimmt ein Bild |
| ⬆ | Bilder in den gewählten Ordner hochladen. Dateien können auch auf die Node gezogen werden |
| 📂 | Öffnet den gewählten Ordner im Explorer |
| ＋ | Neuer Unterordner im gewählten Ordner |
| resize, width, height, keep_proportion, divisible_by, upscale_method | Optionales Skalieren wie bei *Load & Resize Image + Filename* |
| mask_source | **MaskEditor**: die mit dem Button *Mask Editor* (oder Rechtsklick → Open in MaskEditor) gemalte Maske, gespeichert beim Bild in der Bibliothek; ohne Maske der Alphakanal des Bildes. **rectangle**: Rechteck in der Vorschau aufziehen. **freehand**: den zu behaltenden Bereich malen (Pinsel, Lasso, Radierer), außerhalb wird mit `fill_color` gefüllt |
| crop_to_mask | **on** (Standard): Bild und Maske werden auf das umschließende Rechteck der Maske zugeschnitten, wie mit KJNodes *Image Crop By Mask*, vor Größenbegrenzung und Resize. Ohne Maske wird nichts zugeschnitten. Im MaskEditor-Modus zeigt die Vorschau den Zuschnitt als gestrichelten Rahmen. **off**: ganzes Bild |

**Ausgänge:** `image`, `mask`, `width`, `height`, `filename` (ohne Endung),
`folder` (Ordner des Bildes, z. B. `PERSONS/Anna/Face`) und `folder_name` (`Face`).

**Maximale Größe:** Ist die längste Seite eines Bildes größer als 2048 px, skaliert die
Node Bild und Maske proportional herunter, sodass die längste Seite 2048 px hat (nach dem
Zuschnitt, vor dem optionalen Resize). Die Datei in der Bibliothek bleibt unverändert.

**Mit Farbe malen:** Im MaskEditor malt der Farbpinsel (zweites Werkzeug) mit einer
Volltonfarbe. Diese Farbe wird Teil des Ausgabebildes, in jedem `mask_source`-Modus,
und ist in der Vorschau der Node zu sehen. *Remove paint* entfernt sie wieder.

## Die Galerie

* **Ordnerbaum** links, beliebig tief. ▾/▸ klappt einen Ordner zu und auf.
* **Ordner:** *＋ Folder* legt einen Unterordner im angezeigten Ordner an, *Rename*,
  *Move* und *Delete* wirken auf den angezeigten Ordner. Ordner lassen sich auch auf einen
  anderen Ordner ziehen.
* **Bilder:** Ein Klick übernimmt ein Bild. Strg/Umschalt-Klick (oder das Kästchen)
  wählt Bilder aus; dann *Move to…* oder *Delete*, oder die Auswahl auf einen Ordner im
  Baum ziehen.
* **Hinzufügen:** *⬆ Upload*, oder Dateien vom Desktop in den Bildbereich oder auf einen
  Ordner im Baum ziehen.
* **Löschen** fragt nach und verschiebt in den Papierkorb (unter macOS / Linux in den
  versteckten Ordner `.trash` der Bibliothek).
* Beim Verschieben oder Löschen eines Bildes wandern Masken-, Farb- und Formdateien mit.
  Nodes, die ein verschobenes Bild verwenden, ziehen auf den neuen Pfad um.

Masken und Farbe bleiben beim Bild und stehen in jedem Workflow (und zum
Weiterbearbeiten im MaskEditor) wieder zur Verfügung: die MaskEditor-Maske als
`<name>.mask.png`, die Farbe als `<name>.paint.png`, Rechteck oder Freihand-Form als
`<name>.shape.json`. Die Markierungen **M**, **P** und **S** zeigen, was ein Bild hat.

## Wo die Bibliothek liegt

```
ComfyUI/user/cast_library/
├── #TEMP/
├── ACCESSORIES/
├── BACKGROUNDS/
├── CLOTHES/
└── PERSONS/
    └── Anna/
        ├── Face/
        └── Body/
```

Die fünf Hauptordner werden für eine neue Bibliothek angelegt, alles darunter gestaltest
du selbst. Workflows speichern Pfade relativ zu diesem Ordner (z. B.
`PERSONS/Anna/Face/anna_01.png`). Sie funktionieren also weiter, wenn ComfyUI verschoben
oder neu installiert wird, solange der Ordner `user/cast_library` mitkopiert wird.
Ordner, die du im Explorer anlegst, erscheinen ebenfalls. Der versteckte Ordner `.thumbs`
ist nur ein Vorschaubild-Cache und darf jederzeit gelöscht werden.

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
