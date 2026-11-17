"""
Cast Library · Load & Resize Image

Loads an image from the Cast Library (a free folder tree such as
PERSONS/Anna/Face or BACKGROUNDS), optionally resizes it and outputs a mask:

  * MaskEditor  the mask painted in ComfyUI's MaskEditor, stored next to the
                image (<name>.mask.png); without one the image's alpha channel
  * rectangle   the rectangle drawn in the node preview
  * freehand    the shape painted in the node preview; outside it the image is
                filled with fill_color

Colour painted with the MaskEditor's paint brush is stored next to the image
(<name>.paint.png) and drawn into the output image in every mask_source mode.

Rectangle and freehand shapes are kept in the workflow and next to the image
(<name>.shape.json), so they come back whenever the image is picked again.

With crop_to_mask on, image and mask are cropped to the bounding box of the
mask (like KJNodes "Image Crop By Mask"); without a mask nothing is cropped.

Images whose longest side is larger than MAX_SIDE (2048 px) after the crop are
scaled down proportionally to MAX_SIDE before the optional resize; the file in
the library stays untouched.

Resize and mask logic is taken from "Load & Resize Image + Filename"
(Slartibart23), which is based on KJNodes LoadAndResizeImage by kijai
(https://github.com/kijai/ComfyUI-KJNodes, GPL-3.0). This file is therefore
licensed under the GNU General Public License v3.0 (see LICENSE).
"""

import hashlib
import json
import os
from typing import Optional, Tuple

import numpy as np
import torch
from PIL import Image, ImageDraw

from comfy.utils import common_upscale

from . import library as lib

NODE_ID = "CastLibrary_LoadImage"
NODE_NAME = "Cast Library · Load & Resize Image"
MAX_SIDE = 2048  # longest side of the loaded image, larger images are scaled down

FILL_COLORS = {
    "yellow": (1.0, 1.0, 0.0),
    "red": (1.0, 0.0, 0.0),
    "green": (0.0, 1.0, 0.0),
    "blue": (0.0, 0.0, 1.0),
    "white": (1.0, 1.0, 1.0),
    "black": (0.0, 0.0, 0.0),
}


class CastLibraryLoadImage:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "library_image": (
                    "STRING",
                    {
                        "default": "",
                        "tooltip": "Library image, relative to ComfyUI/user/cast_library. "
                                   "Pick it with the gallery in the node",
                    },
                ),
                "resize": ("BOOLEAN", {"default": False}),
                "width": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1,
                                  "tooltip": "Target width (only used when resize is enabled)"}),
                "height": ("INT", {"default": 512, "min": 1, "max": 16384, "step": 1,
                                   "tooltip": "Target height (only used when resize is enabled)"}),
                "keep_proportion": ("BOOLEAN", {"default": False}),
                "divisible_by": ("INT", {"default": 32, "min": 1, "max": 256, "step": 1,
                                         "tooltip": "Round output dimensions to be divisible by this value"}),
                "upscale_method": (["nearest-exact", "bilinear", "area", "bicubic", "lanczos"],
                                   {"default": "lanczos"}),
                "mask_source": (
                    ["MaskEditor", "rectangle", "freehand"],
                    {
                        "default": "MaskEditor",
                        "tooltip": "Which mask comes out at 'mask' (crop with e.g. Image Crop By Mask). "
                                   "MaskEditor: the mask painted via the Mask Editor button / right-click -> "
                                   "Open in MaskEditor, stored with the library image (else the alpha channel). "
                                   "rectangle: the rectangle drawn in the preview. "
                                   "freehand: the shape painted in the preview; outside it the image "
                                   "is filled with fill_color",
                    },
                ),
                "fill_color": (list(FILL_COLORS.keys()), {"default": "yellow",
                                                          "tooltip": "Colour for the area outside the freehand shape"}),
                "crop_data": ("STRING", {"default": "", "tooltip": "Written by the editor in the node preview"}),
                "crop_to_mask": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "on",
                        "label_off": "off",
                        "tooltip": "Crop image and mask to the bounding box of the mask (like KJNodes Image Crop "
                                   "By Mask), before the size limit and resize. Without a mask nothing is cropped",
                    },
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("image", "mask", "width", "height", "filename", "folder", "folder_name")
    OUTPUT_TOOLTIPS = (
        "The library image (resized if enabled)",
        "Mask from mask_source",
        "Output width",
        "Output height",
        "File name without extension",
        "Folder of the image inside the library, e.g. 'PERSONS/Anna/Face'",
        "Name of that folder, e.g. 'Face'",
    )
    FUNCTION = "load_image"
    CATEGORY = "Cast Library"
    DESCRIPTION = ("Loads an image from your Cast Library (folders such as PERSONS, BACKGROUNDS, "
                   "ACCESSORIES, ...) with resize and mask (MaskEditor, rectangle or freehand). "
                   f"Images larger than {MAX_SIDE} px on the longest side are scaled down to {MAX_SIDE} px.")

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _pil_to_tensor(pil_img: Image.Image) -> torch.Tensor:
        arr = np.array(pil_img).astype(np.float32) / 255.0
        return torch.from_numpy(arr).unsqueeze(0)

    @staticmethod
    def limited_size(w: int, h: int) -> Tuple[int, int]:
        """(w, h) scaled down so that the longest side is at most MAX_SIDE."""
        longest = max(w, h)
        if longest <= MAX_SIDE:
            return w, h
        scale = MAX_SIDE / longest
        return max(1, round(w * scale)), max(1, round(h * scale))

    @staticmethod
    def _crop_to_mask(image: torch.Tensor, mask: torch.Tensor):
        """Crop to the bounding box of mask >= 0.5 (as Image Crop By Mask rounds); no mask -> unchanged."""
        hit = mask[0] >= 0.5
        rows = torch.where(hit.any(dim=1))[0]
        if len(rows) == 0:
            return image, mask
        cols = torch.where(hit.any(dim=0))[0]
        y0, y1 = int(rows[0]), int(rows[-1]) + 1
        x0, x1 = int(cols[0]), int(cols[-1]) + 1
        return image[:, y0:y1, x0:x1, :], mask[:, y0:y1, x0:x1]

    @classmethod
    def _limit_size(cls, image: torch.Tensor, mask: torch.Tensor):
        """Scale image and mask down proportionally if the longest side exceeds MAX_SIDE."""
        _, h, w, _ = image.shape
        nw, nh = cls.limited_size(w, h)
        if (nw, nh) == (w, h):
            return image, mask
        print(f"[{NODE_ID}] image {w}x{h} is larger than {MAX_SIDE} px, scaled down to {nw}x{nh}")
        image = common_upscale(image.movedim(-1, 1), nw, nh, "lanczos", "disabled").movedim(1, -1).clamp(0.0, 1.0)
        mask = common_upscale(mask.unsqueeze(1), nw, nh, "bilinear", "disabled").squeeze(1).clamp(0.0, 1.0)
        return image, mask

    @staticmethod
    def _resize(tensor: torch.Tensor, target_w: int, target_h: int, keep_proportion: bool,
                divisible_by: int, method: str):
        _, orig_h, orig_w, _ = tensor.shape
        if keep_proportion:
            ratio = min(target_w / orig_w, target_h / orig_h)
            target_w = int(orig_w * ratio)
            target_h = int(orig_h * ratio)
        if divisible_by > 1:
            target_w = max(1, (target_w // divisible_by) * divisible_by)
            target_h = max(1, (target_h // divisible_by) * divisible_by)
        t = tensor.movedim(-1, 1)
        t = common_upscale(t, target_w, target_h, method, "disabled")
        return t.movedim(1, -1), target_w, target_h

    @staticmethod
    def _parse_crop_data(crop_data: str) -> dict:
        if not crop_data or not crop_data.strip():
            return {}
        try:
            data = json.loads(crop_data)
        except json.JSONDecodeError:
            print(f"[{NODE_ID}] ignoring invalid crop_data: {crop_data[:80]!r}")
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _rect_to_pixels(rect, img_w: int, img_h: int) -> Optional[Tuple[int, int, int, int]]:
        try:
            x, y, w, h = (float(v) for v in rect)
        except (TypeError, ValueError):
            return None
        x0 = int(round(min(max(x, 0.0), 1.0) * img_w))
        y0 = int(round(min(max(y, 0.0), 1.0) * img_h))
        x1 = int(round(min(max(x + w, 0.0), 1.0) * img_w))
        y1 = int(round(min(max(y + h, 0.0), 1.0) * img_h))
        if x1 - x0 < 1 or y1 - y0 < 1:
            return None
        return x0, y0, x1, y1

    @staticmethod
    def _render_shape(strokes, img_w: int, img_h: int) -> np.ndarray:
        canvas = Image.new("L", (img_w, img_h), 0)
        draw = ImageDraw.Draw(canvas)
        for stroke in strokes or []:
            if not isinstance(stroke, dict):
                continue
            pts = [(float(p[0]) * img_w, float(p[1]) * img_h) for p in stroke.get("p", []) if len(p) >= 2]
            if not pts:
                continue
            kind = stroke.get("t", "brush")
            if kind == "lasso":
                if len(pts) >= 3:
                    draw.polygon(pts, fill=255)
                continue
            value = 0 if kind == "erase" else 255
            width = max(1.0, float(stroke.get("s", 0.02)) * img_w)
            r = width / 2.0
            if len(pts) > 1:
                draw.line(pts, fill=value, width=int(round(width)))
            for px, py in pts:
                draw.ellipse((px - r, py - r, px + r, py + r), fill=value)
        return np.array(canvas) > 127

    def _apply_mask_source(self, image, mask, mask_source, crop_data, fill_color):
        if mask_source not in ("rectangle", "freehand"):
            return image, mask
        frames, img_h, img_w, _ = image.shape
        data = self._parse_crop_data(crop_data)
        full = torch.ones((frames, img_h, img_w), dtype=mask.dtype, device=mask.device)

        if mask_source == "rectangle":
            box = self._rect_to_pixels(data.get("rect"), img_w, img_h)
            if box is None:
                print(f"[{NODE_ID}] mask_source=rectangle but no rectangle drawn, mask covers the full image")
                return image, full
            x0, y0, x1, y1 = box
            out_mask = torch.zeros_like(full)
            out_mask[:, y0:y1, x0:x1] = 1.0
            return image, out_mask

        shape = self._render_shape(data.get("strokes"), img_w, img_h)
        if not shape.any():
            print(f"[{NODE_ID}] mask_source=freehand but nothing painted, mask covers the full image")
            return image, full
        shape_t = torch.from_numpy(shape).to(image.device)
        out = image.clone()
        color = torch.tensor(FILL_COLORS.get(fill_color, FILL_COLORS["yellow"]), dtype=out.dtype, device=out.device)
        out[:, ~shape_t] = color
        return out, shape_t.to(mask.dtype).unsqueeze(0).repeat(frames, 1, 1)

    # ------------------------------------------------------------------
    # main
    # ------------------------------------------------------------------

    def load_image(self, library_image, resize, width, height, keep_proportion, divisible_by,
                   upscale_method, mask_source="MaskEditor", fill_color="yellow", crop_data="", crop_to_mask=True):
        image_path = lib.image_file(library_image)
        filename_stem = os.path.splitext(os.path.basename(image_path))[0]
        folder, folder_name = lib.describe(library_image)

        # first frame only, like the preview and the MaskEditor; phone photos (MPO)
        # carry extra frames of another size
        rgb, alpha = lib.open_rgb_alpha(image_path)
        img_w, img_h = rgb.size
        out_image = self._pil_to_tensor(rgb)

        # MaskEditor mask stored with the library image replaces the alpha mask
        stored = lib.load_mask(image_path, (img_w, img_h))
        if stored is not None:
            out_mask = torch.from_numpy(np.asarray(stored, dtype=np.float32) / 255.0).unsqueeze(0)
        elif alpha is not None:
            out_mask = 1.0 - torch.from_numpy(np.asarray(alpha, dtype=np.float32) / 255.0).unsqueeze(0)
        else:
            out_mask = torch.zeros((1, img_h, img_w), dtype=torch.float32)

        # colour painted in the MaskEditor becomes part of the image (in every mask_source mode)
        paint = lib.load_paint(image_path, (img_w, img_h))
        if paint is not None:
            p = torch.from_numpy(np.asarray(paint, dtype=np.float32) / 255.0).to(out_image.device)
            alpha = p[..., 3:4]
            out_image = out_image * (1.0 - alpha) + p[..., :3] * alpha

        out_image, out_mask = self._apply_mask_source(out_image, out_mask, mask_source, crop_data, fill_color)
        if crop_to_mask:
            out_image, out_mask = self._crop_to_mask(out_image, out_mask)
        out_image, out_mask = self._limit_size(out_image, out_mask)

        if resize:
            out_image, final_w, final_h = self._resize(out_image, width, height, keep_proportion,
                                                       divisible_by, upscale_method)
            mask_4d, _, _ = self._resize(out_mask.unsqueeze(-1), width, height, keep_proportion,
                                         divisible_by, upscale_method)
            out_mask = mask_4d.squeeze(-1)
        else:
            _, final_h, final_w, _ = out_image.shape

        return out_image, out_mask, final_w, final_h, filename_stem, folder, folder_name

    # ------------------------------------------------------------------
    # cache / validation
    # ------------------------------------------------------------------

    @classmethod
    def IS_CHANGED(cls, library_image, **kwargs):
        try:
            full = lib.image_file(library_image)
            h = hashlib.sha256()
            with open(full, "rb") as f:
                h.update(f.read())
            for kind, sidecar in (("mask", lib.mask_path(full)), ("paint", lib.paint_path(full))):
                if os.path.isfile(sidecar):
                    st = os.stat(sidecar)
                    h.update(f"|{kind}|{st.st_mtime_ns}|{st.st_size}".encode())
            return h.hexdigest()
        except Exception:
            return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, library_image, **kwargs):
        if not (library_image or "").strip():
            return "No library image selected: open the gallery in the node and pick an image."
        try:
            lib.image_file(library_image)
        except lib.LibraryError as e:
            return str(e)
        return True
