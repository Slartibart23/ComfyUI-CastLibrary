# ComfyUI Cast Library

An image library right inside ComfyUI. Keep your **persons** (each with face and body
areas, more areas on demand), **accessories**, **backgrounds** and any other library you
like in one place, pick an image in a gallery and get it into your workflow as
**image + mask** with optional resize.

[Deutsche Anleitung](README.de.md)

## The node: Cast Library · Load & Resize Image

| Control | What it does |
| --- | --- |
| Library / area dropdowns | Choose a person or library and one of its areas (folders) |
| 🖼 Gallery | Opens the library window: all persons and libraries on the left, thumbnails on the right. Click an image to use it |
| ⬆ | Upload images into the selected area. You can also drop files onto the node or into the gallery |
| 📂 | Opens the selected folder in Explorer (for renaming or deleting) |
| ＋ | New person (gets the areas *Face* and *Body*), new library, or new area in the selected library |
| resize, width, height, keep_proportion, divisible_by, upscale_method | Optional resize, same as *Load & Resize Image + Filename* |
| mask_source | **MaskEditor**: the mask painted with the *Mask Editor* button (or right-click → Open in MaskEditor), stored with the library image; without one the image's alpha channel. **rectangle**: drag a rectangle in the preview. **freehand**: paint the area to keep (brush, lasso, eraser); outside it the image is filled with `fill_color` |

**Maximum size:** if the longest side of an image is larger than 2048 px, the node
scales image and mask down proportionally so that the longest side is 2048 px (before
the optional resize). The file in the library stays untouched; the preview line shows
the output size, e.g. `4000×3000 → 2048×1536`.

**Outputs:** `image`, `mask`, `width`, `height`, `filename` (without extension),
`name` (person or library, e.g. `Anna`), `area` (e.g. `Face`, empty for the main
folder of a library).

**Painting with colour:** in the MaskEditor, the paint brush (second tool) paints
with a solid colour. That colour becomes part of the output image, in every
`mask_source` mode, and is shown in the node preview. *Remove paint* deletes it again.

Masks and colour are kept with the image, so they come back in every workflow (and
for further editing in the MaskEditor): the MaskEditor mask as `<name>.mask.png`, the
colour as `<name>.paint.png` and the rectangle or freehand shape as
`<name>.shape.json`. The shape is also stored in the workflow. In the gallery the
badges **M**, **P** and **S** show which of them an image has.

## Where the library lives

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

`Persons`, `Accessories` and `Backgrounds` are created on first start. Workflows store
paths relative to this folder (e.g. `Persons/Anna/Face/anna_01.png`), so they keep
working when ComfyUI is moved or reinstalled, as long as you copy the
`user/cast_library` folder along.

Any folder you create in Explorer shows up too: sub folders of a person or library are
its areas. Images directly in a library folder appear as its *(main folder)* area.
When you rename or delete an image in Explorer, rename or delete its `.mask.png` and
`.shape.json` with it. The hidden `.thumbs` folder is a thumbnail cache and can be
deleted at any time.

## Install

Clone into `ComfyUI/custom_nodes` and restart ComfyUI:

```
cd ComfyUI/custom_nodes
git clone https://github.com/Slartibart23/ComfyUI-CastLibrary
```

No extra Python packages are needed.

## Notes

* The 📂 button opens Explorer on the computer that runs ComfyUI.
* The MaskEditor only reads images from ComfyUI's input/output/temp folders. The node
  therefore hands it working copies (in `input/cast_library`, cleaned up after two
  days), and after *Save* it turns the result into `<name>.mask.png` and
  `<name>.paint.png`.
* Tested with ComfyUI 0.41 and frontend 1.55.

## License

GPL-3.0. The resize and mask logic comes from *Load & Resize Image + Filename*, which
is based on [KJNodes](https://github.com/kijai/ComfyUI-KJNodes) LoadAndResizeImage by kijai.
