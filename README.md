# ComfyUI Cast Library

An image library right inside ComfyUI. Keep persons, backgrounds, accessories, clothes
and anything else in your own folder tree, organise it in the node, pick an image in a
gallery and get it into your workflow as **image + mask** with optional crop and resize.

[Deutsche Anleitung](README.de.md)

## The node: Cast Library · Load & Resize Image

| Control | What it does |
| --- | --- |
| Folder dropdown | The folder for the gallery and for uploads |
| 🖼 Gallery | Opens the library window (see below). Click an image to use it |
| ⬆ | Upload images into the selected folder. You can also drop files onto the node |
| 📂 | Opens the selected folder in Explorer |
| ＋ | New folder inside the selected folder |
| resize, width, height, keep_proportion, divisible_by, upscale_method | Optional resize, same as *Load & Resize Image + Filename* |
| mask_source | **MaskEditor**: the mask painted with the *Mask Editor* button (or right-click → Open in MaskEditor), stored with the library image; without one the image's alpha channel. **rectangle**: drag a rectangle in the preview. **freehand**: paint the area to keep (brush, lasso, eraser); outside it the image is filled with `fill_color` |
| crop_to_mask | **on** (default): image and mask are cut to the bounding box of the mask, like KJNodes *Image Crop By Mask*, before the size limit and the resize. Without a mask nothing is cropped. In MaskEditor mode the preview shows the crop as a dashed frame. **off**: full image |

**Outputs:** `image`, `mask`, `width`, `height`, `filename` (without extension),
`folder` (folder of the image, e.g. `PERSONS/Anna/Face`) and `folder_name` (`Face`).

**Maximum size:** if the longest side of an image is larger than 2048 px, the node
scales image and mask down proportionally so that the longest side is 2048 px (after the
crop, before the optional resize). The file in the library stays untouched.

**Painting with colour:** in the MaskEditor, the paint brush (second tool) paints
with a solid colour. That colour becomes part of the output image, in every
`mask_source` mode, and is shown in the node preview. *Remove paint* deletes it again.

## The gallery

* **Folder tree** on the left, any depth. ▾/▸ folds a folder.
* **Folders:** *＋ Folder* creates a sub folder of the shown folder, *Rename*, *Move* and
  *Delete* act on the shown folder. Folders can also be dragged onto another folder.
* **Images:** click uses an image. Ctrl/Shift-click (or the check box) selects images;
  then *Move to…* or *Delete*, or drag them onto a folder in the tree.
* **Adding:** *⬆ Upload*, or drop files from the desktop into the image area or onto a
  folder in the tree.
* **Deleting** asks first and moves the files to the recycle bin (on macOS / Linux into
  the library's hidden `.trash` folder).
* Moving or deleting an image takes its mask, colour and shape files along. Nodes that
  use a moved image follow it to the new place.

Masks and colour are kept with the image, so they come back in every workflow (and
for further editing in the MaskEditor): the MaskEditor mask as `<name>.mask.png`, the
colour as `<name>.paint.png` and the rectangle or freehand shape as
`<name>.shape.json`. The badges **M**, **P** and **S** show which of them an image has.

## Where the library lives

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

The five top folders are created for a new library; everything below is up to you.
Workflows store paths relative to this folder (e.g. `PERSONS/Anna/Face/anna_01.png`),
so they keep working when ComfyUI is moved or reinstalled, as long as you copy the
`user/cast_library` folder along. Folders made in Explorer show up as well. The hidden
`.thumbs` folder is a thumbnail cache and can be deleted at any time.

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
