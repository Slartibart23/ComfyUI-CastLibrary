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
| 💾 Drop: save / ⏳ Drop: temp | Was mit Bildern passiert, die auf die Node gezogen werden. **save** (aus): Sie werden im gewählten Ordner gespeichert. **temp** (an): Sie werden verwendet, ohne sie in der Bibliothek zu speichern (abgelegt in `input/cast_library_drops`, dasselbe Bild wird beim erneuten Reinziehen wiederverwendet). Im Compose-Modus kommen reingezogene Bilder in die Komposition |
| resize, width, height, keep_proportion, divisible_by, upscale_method | Optionales Skalieren wie bei *Load & Resize Image + Filename* |
| mask_source | **MaskEditor**: die mit dem Button *Mask Editor* (oder Rechtsklick → Open in MaskEditor) gemalte Maske, gespeichert beim Bild in der Bibliothek; ohne Maske der Alphakanal des Bildes. **rectangle**: Rechteck in der Vorschau aufziehen. **freehand**: den zu behaltenden Bereich malen (Pinsel, Lasso, Radierer), außerhalb wird mit `fill_color` gefüllt |
| crop_to_mask | **on** (Standard): Bild und Maske werden auf das umschließende Rechteck der Maske zugeschnitten, wie mit KJNodes *Image Crop By Mask*, vor Größenbegrenzung und Resize. Ohne Maske wird nichts zugeschnitten. Im MaskEditor-Modus zeigt die Vorschau den Zuschnitt als gestrichelten Rahmen. **off**: ganzes Bild |
| compose | **on**: Die Node gibt stattdessen eine Komposition aus mehreren Bildern aus (siehe unten), **🧩 Compose** öffnet den Composer. **off** (Standard): ein Bild |

**Ausgänge:** `image`, `mask`, `width`, `height`, `filename` (ohne Endung),
`folder` (Ordner des Bildes, z. B. `PERSONS/Anna/Face`) und `folder_name` (`Face`).

**Maximale Größe:** Ist die längste Seite eines Bildes größer als 2048 px, skaliert die
Node Bild und Maske proportional herunter, sodass die längste Seite 2048 px hat (nach dem
Zuschnitt, vor dem optionalen Resize). Die Datei in der Bibliothek bleibt unverändert.

**Mit Farbe malen:** Im MaskEditor malt der Farbpinsel (zweites Werkzeug) mit einer
Volltonfarbe. Diese Farbe wird Teil des Ausgabebildes, in jedem `mask_source`-Modus,
und ist in der Vorschau der Node zu sehen. *Remove paint* entfernt sie wieder.

## Compose: mehrere Bilder in einem Bild

Ist `compose` an, öffnet **🧩 Compose** (oder ein Klick auf die Vorschau) den Composer:

* **＋ Add images** öffnet die Galerie; jeder Klick fügt ein Bild hinzu, aus beliebigen
  Ordnern.
* **Arrange** wie bei *Stitch Images*: **Row** (gleiche Höhe nebeneinander), **Column**
  (gleiche Breite untereinander) oder **Grid**, mit **Spacing** zwischen den Bildern. Die
  Abstände zeigen den Hintergrund.
* Danach frei anordnen: ziehen zum Verschieben, an einer Ecke ziehen zum Skalieren
  (Seitenverhältnis bleibt), **✂** (oder Doppelklick) beschneidet mit den Kantengriffen,
  **↑/↓** ändern die Reihenfolge, **×** oder Entf entfernt.
* **Canvas:** 1:1, 3:4, 4:3, 16:9, 9:16, *fit content* (die Fläche richtet sich nach den
  Bildern) oder *custom* Breite × Höhe. **Background:** eine Farbe und/oder ein
  Bibliotheksbild, das die Fläche füllt.
* **🖌 Paint** malt mit Volltonfarben über die Komposition: **Brush**, **Lasso** (füllt
  eine Umrandung), **Eraser** (entfernt nur Farbe), **Pipette** (nimmt eine Farbe aus der
  Komposition), mit Größe, Deckkraft und Härte (weiche Kanten), **Undo** und **Clear**.
  Die Farbe gehört zur Fläche, nicht zu einem Bild: erst anordnen, dann malen.

Die Komposition wird aus den Originaldateien berechnet (mit der im MaskEditor gemalten
Farbe und der Transparenz freigestellter PNGs) samt Malerei, ihre längste Seite ist höchstens
2048 px, und der mask-Ausgang ist leer. `filename`, `folder` und `folder_name` nennen alle
Bilder, durch Komma getrennt. Das Layout wird im Workflow gespeichert, lässt sich
jederzeit wieder bearbeiten und folgt Bildern, die in der Galerie verschoben werden.

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
