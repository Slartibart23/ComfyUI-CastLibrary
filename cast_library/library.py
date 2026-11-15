"""
Cast Library: file layout, listing, sidecar files and thumbnails.

The library is a plain folder tree below ComfyUI's user directory
(``ComfyUI/user/cast_library``). Workflows only store paths relative to that
root, so moving or reinstalling ComfyUI does not break them.

    cast_library/
    ├── Persons/          persons, one library per person
    │   └── Anna/
    │       ├── Face/     areas (sub folders), Face + Body by default
    │       └── Body/
    ├── Accessories/      plain libraries (images directly inside and/or areas)
    └── Backgrounds/

Next to every image two optional sidecar files can exist (same stem):

    anna_01.png
    anna_01.mask.png    mask painted in ComfyUI's MaskEditor (white = masked)
    anna_01.paint.png   colour painted in the MaskEditor (RGBA, drawn over the image)
    anna_01.shape.json  rectangle / freehand shape drawn in the node preview

Rename or delete an image in Explorer together with its sidecars.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from typing import List, Optional, Tuple

import numpy as np
from PIL import Image, ImageOps

ROOT_NAME = "cast_library"
PERSONS_DIR = "Persons"
DEFAULT_PERSON_AREAS = ("Face", "Body")
DEFAULT_LIBRARIES = ("Accessories", "Backgrounds")

IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif")
MASK_SUFFIX = ".mask.png"
PAINT_SUFFIX = ".paint.png"
SHAPE_SUFFIX = ".shape.json"
THUMB_DIR = ".thumbs"
THUMB_SIZE = 320
MASK_EDITOR_SUBFOLDER = "cast_library"

_INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_CLIPSPACE_PAINTED = re.compile(r"^clipspace-painted-masked-(\d+)\.png$")

_root_override: Optional[str] = None


class LibraryError(Exception):
    """Error with a message that is shown to the user as is."""


# ----------------------------------------------------------------------
# root / paths
# ----------------------------------------------------------------------

def set_root(path: Optional[str]) -> None:
    """Use another root folder (tests)."""
    global _root_override
    _root_override = path


def root_dir() -> str:
    if _root_override:
        return _root_override
    import folder_paths
    return os.path.join(folder_paths.get_user_directory(), ROOT_NAME)


def ensure_root() -> str:
    """Create the root folder; on first creation also the default libraries."""
    root = root_dir()
    if not os.path.isdir(root):
        os.makedirs(os.path.join(root, PERSONS_DIR), exist_ok=True)
        for name in DEFAULT_LIBRARIES:
            os.makedirs(os.path.join(root, name), exist_ok=True)
    return root


def natural_key(name: str):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", name)]


def clean_rel(rel: str) -> str:
    """Normalize a relative library path to 'a/b/c' (forward slashes)."""
    rel = (rel or "").replace("\\", "/").strip().strip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    for p in parts:
        if p == ".." or p.startswith("."):
            raise LibraryError(f"Invalid library path: {rel!r}")
    return "/".join(parts)


def resolve(rel: str) -> str:
    """Absolute path for a relative library path; never leaves the root."""
    root = os.path.abspath(ensure_root())
    rel = clean_rel(rel)
    full = os.path.abspath(os.path.join(root, *rel.split("/"))) if rel else root
    if os.path.commonpath([root, full]) != root:
        raise LibraryError(f"Invalid library path: {rel!r}")
    return full


def to_rel(full: str) -> str:
    root = os.path.abspath(root_dir())
    rel = os.path.relpath(os.path.abspath(full), root).replace("\\", "/")
    return "" if rel == "." else rel


def is_image_name(name: str) -> bool:
    low = name.lower()
    return (low.endswith(IMAGE_EXTENSIONS) and not low.endswith((MASK_SUFFIX, PAINT_SUFFIX))
            and not name.startswith("."))


def mask_path(image_full: str) -> str:
    return os.path.splitext(image_full)[0] + MASK_SUFFIX


def paint_path(image_full: str) -> str:
    return os.path.splitext(image_full)[0] + PAINT_SUFFIX


def _mtime(path: str) -> int:
    return int(os.stat(path).st_mtime_ns) if os.path.isfile(path) else 0


def shape_path(image_full: str) -> str:
    return os.path.splitext(image_full)[0] + SHAPE_SUFFIX


def check_name(name: str) -> str:
    """Validate a new folder name."""
    name = (name or "").strip()
    if not name:
        raise LibraryError("Please enter a name.")
    if name.startswith(".") or name.endswith(".") or _INVALID_NAME.search(name):
        raise LibraryError(f'"{name}" is not a valid folder name (not allowed: < > : " / \\ | ? * and a leading or trailing dot).')
    if len(name) > 80:
        raise LibraryError("The name is too long (max. 80 characters).")
    return name


def image_file(rel: str) -> str:
    """Absolute path of an existing library image."""
    full = resolve(rel)
    if not os.path.isfile(full) or not is_image_name(os.path.basename(full)):
        raise LibraryError(f"Image not found in the library: {rel!r}")
    return full


def describe(rel: str) -> Tuple[str, str]:
    """(library name, area name) of an image path, e.g. ('Anna', 'Face')."""
    parts = clean_rel(rel).split("/")[:-1]
    if parts and parts[0] == PERSONS_DIR:
        parts = parts[1:]
    name = parts[0] if parts else ""
    area = parts[1] if len(parts) > 1 else ""
    return name, area


# ----------------------------------------------------------------------
# listing
# ----------------------------------------------------------------------

def _subdirs(full: str) -> List[str]:
    try:
        names = [n for n in os.listdir(full) if not n.startswith(".") and os.path.isdir(os.path.join(full, n))]
    except FileNotFoundError:
        return []
    return sorted(names, key=natural_key)


def _image_names(full: str) -> List[str]:
    try:
        names = [n for n in os.listdir(full) if is_image_name(n) and os.path.isfile(os.path.join(full, n))]
    except FileNotFoundError:
        return []
    # by stem first, so "face.png" comes before "face (1).png"
    return sorted(names, key=lambda n: (natural_key(os.path.splitext(n)[0]), n.lower()))


def _library_entry(full: str, kind: str) -> dict:
    rel = to_rel(full)
    dirs = _subdirs(full)
    if kind == "person":
        # Face, Body first, then the person's own areas alphabetically
        order = {a.lower(): i for i, a in enumerate(DEFAULT_PERSON_AREAS)}
        dirs.sort(key=lambda d: order.get(d.lower(), len(order)))
    areas = [
        {"path": f"{rel}/{d}", "name": d, "count": len(_image_names(os.path.join(full, d)))}
        for d in dirs
    ]
    own = len(_image_names(full))
    if own or not areas:
        # images directly in the library folder form an unnamed area
        areas.insert(0, {"path": rel, "name": "", "count": own})
    return {"path": rel, "name": os.path.basename(full), "kind": kind, "areas": areas}


def tree() -> dict:
    root = ensure_root()
    persons_full = os.path.join(root, PERSONS_DIR)
    os.makedirs(persons_full, exist_ok=True)
    libraries = [_library_entry(os.path.join(persons_full, d), "person") for d in _subdirs(persons_full)]
    libraries += [
        _library_entry(os.path.join(root, d), "library")
        for d in _subdirs(root) if d != PERSONS_DIR
    ]
    return {"root": root, "persons_dir": PERSONS_DIR, "libraries": libraries}


def image_info(full: str) -> dict:
    st = os.stat(full)
    return {
        "name": os.path.basename(full),
        "path": to_rel(full),
        "v": f"{st.st_mtime_ns}-{st.st_size}",
        "mask": _mtime(mask_path(full)),
        "paint": _mtime(paint_path(full)),
        "shape": os.path.isfile(shape_path(full)),
    }


def list_images(dir_rel: str) -> List[dict]:
    full = resolve(dir_rel)
    if not os.path.isdir(full):
        raise LibraryError(f"Folder not found in the library: {dir_rel!r}")
    return [image_info(os.path.join(full, n)) for n in _image_names(full)]


# ----------------------------------------------------------------------
# creating folders
# ----------------------------------------------------------------------

def _mkdir_new(full: str, label: str) -> None:
    if os.path.exists(full):
        raise LibraryError(f'{label} "{os.path.basename(full)}" already exists.')
    os.makedirs(full)


def create_person(name: str) -> str:
    name = check_name(name)
    full = os.path.join(ensure_root(), PERSONS_DIR, name)
    _mkdir_new(full, "Person")
    for area in DEFAULT_PERSON_AREAS:
        os.makedirs(os.path.join(full, area), exist_ok=True)
    return to_rel(full)


def create_library(name: str) -> str:
    name = check_name(name)
    if name.lower() == PERSONS_DIR.lower():
        raise LibraryError(f'"{PERSONS_DIR}" is reserved for persons.')
    full = os.path.join(ensure_root(), name)
    _mkdir_new(full, "Library")
    return to_rel(full)


def is_library(rel: str) -> bool:
    parts = clean_rel(rel).split("/")
    if parts[0] == PERSONS_DIR:
        return len(parts) == 2
    return len(parts) == 1 and parts[0] != ""


def create_area(library_rel: str, name: str) -> str:
    name = check_name(name)
    if not is_library(library_rel):
        raise LibraryError(f"Not a library: {library_rel!r}")
    lib = resolve(library_rel)
    if not os.path.isdir(lib):
        raise LibraryError(f"Library not found: {library_rel!r}")
    full = os.path.join(lib, name)
    _mkdir_new(full, "Area")
    return to_rel(full)


# ----------------------------------------------------------------------
# upload
# ----------------------------------------------------------------------

def save_upload(dir_rel: str, filename: str, data: bytes) -> str:
    """Store an uploaded image in a library folder; never overwrites. Returns the relative path."""
    folder = resolve(dir_rel)
    if not os.path.isdir(folder) or not clean_rel(dir_rel):
        raise LibraryError(f"Upload folder not found in the library: {dir_rel!r}")
    base = os.path.basename((filename or "").replace("\\", "/")).strip()
    stem, ext = os.path.splitext(base)
    stem = _INVALID_NAME.sub("_", stem).strip(" .") or "image"
    ext = ext.lower()
    if ext not in IMAGE_EXTENSIONS:
        raise LibraryError(f"Not a supported image file: {base!r}")
    if stem.lower().endswith(".mask"):
        stem = stem[:-5] + "_mask"
    try:
        from io import BytesIO
        with Image.open(BytesIO(data)) as im:
            im.verify()
    except Exception:
        raise LibraryError(f"The file is not a readable image: {base!r}") from None
    target = os.path.join(folder, stem + ext)
    n = 1
    while os.path.exists(target):
        target = os.path.join(folder, f"{stem} ({n}){ext}")
        n += 1
    with open(target, "wb") as f:
        f.write(data)
    return to_rel(target)


# ----------------------------------------------------------------------
# images, masks, shapes
# ----------------------------------------------------------------------

def open_rgb_alpha(full: str) -> Tuple[Image.Image, Optional[Image.Image]]:
    """First frame, EXIF-rotated: (RGB image, alpha channel or None)."""
    with Image.open(full) as im:
        im = ImageOps.exif_transpose(im)
        im.load()
        alpha = None
        if "A" in im.getbands():
            alpha = im.getchannel("A")
        elif im.mode == "P" and "transparency" in im.info:
            alpha = im.convert("RGBA").getchannel("A")
        return im.convert("RGB"), alpha


def load_mask(image_full: str, size: Tuple[int, int]) -> Optional[Image.Image]:
    """The MaskEditor sidecar mask as 'L' image (white = masked) at ``size``, or None."""
    mp = mask_path(image_full)
    if not os.path.isfile(mp):
        return None
    with Image.open(mp) as m:
        m = m.convert("L")
        if m.size != size:
            m = m.resize(size, Image.Resampling.BILINEAR)
        return m


def load_paint(image_full: str, size: Tuple[int, int]) -> Optional[Image.Image]:
    """The colour painted in the MaskEditor as 'RGBA' image at ``size``, or None."""
    pp = paint_path(image_full)
    if not os.path.isfile(pp):
        return None
    with Image.open(pp) as p:
        p = p.convert("RGBA")
        if p.size != size:
            p = p.resize(size, Image.Resampling.BILINEAR)
        return p


def read_shape(image_full: str) -> dict:
    sp = shape_path(image_full)
    if not os.path.isfile(sp):
        return {}
    try:
        with open(sp, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_shape(image_full: str, data: dict) -> None:
    sp = shape_path(image_full)
    clean = {}
    if isinstance(data, dict):
        if isinstance(data.get("rect"), list) and len(data["rect"]) == 4:
            clean["rect"] = data["rect"]
        if isinstance(data.get("strokes"), list) and data["strokes"]:
            clean["strokes"] = data["strokes"]
    if not clean:
        if os.path.isfile(sp):
            os.remove(sp)
        return
    with open(sp, "w", encoding="utf-8") as f:
        json.dump(clean, f, separators=(",", ":"))


def delete_mask(image_full: str) -> None:
    mp = mask_path(image_full)
    if os.path.isfile(mp):
        os.remove(mp)


def delete_paint(image_full: str) -> None:
    pp = paint_path(image_full)
    if os.path.isfile(pp):
        os.remove(pp)


def thumbnail(rel: str) -> str:
    """Path of a cached JPEG thumbnail of a library image."""
    full = image_file(rel)
    st = os.stat(full)
    paint_v = _mtime(paint_path(full))
    key = hashlib.sha1(f"{to_rel(full)}|{st.st_mtime_ns}|{st.st_size}|{paint_v}|{THUMB_SIZE}".encode("utf-8")).hexdigest()
    folder = os.path.join(ensure_root(), THUMB_DIR)
    target = os.path.join(folder, key + ".jpg")
    if os.path.isfile(target):
        return target
    os.makedirs(folder, exist_ok=True)
    if sys.platform == "win32":
        _hide_on_windows(folder)
    rgb, alpha = open_rgb_alpha(full)
    paint = load_paint(full, rgb.size) if paint_v else None
    if paint is not None:
        rgb = Image.alpha_composite(rgb.convert("RGBA"), paint).convert("RGB")
    if alpha is not None:
        bg = Image.new("RGB", rgb.size, (40, 40, 40))
        bg.paste(rgb, mask=alpha)
        rgb = bg
    rgb.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)
    tmp = target + ".tmp"
    rgb.save(tmp, "JPEG", quality=85)
    os.replace(tmp, target)
    return target


def _hide_on_windows(path: str) -> None:
    try:
        import ctypes
        ctypes.windll.kernel32.SetFileAttributesW(str(path), 0x02)  # FILE_ATTRIBUTE_HIDDEN
    except Exception:
        pass


# ----------------------------------------------------------------------
# ComfyUI MaskEditor bridge
# ----------------------------------------------------------------------
# The MaskEditor only reads images through ComfyUI's /view route. For a
# library image the node points it at input/cast_library/
# clipspace-painted-masked-<n>.png. For files named like that the MaskEditor
# also loads clipspace-mask-<n>.png (image + mask in the alpha channel,
# transparent = masked) and clipspace-paint-<n>.png (the colour layer) from the
# same folder, so a stored mask and stored paint come back for editing.
# After saving, the MaskEditor uploads new clipspace-mask-<ts>.png and
# clipspace-paint-<ts>.png to input/; they become the sidecar files
# <name>.mask.png and <name>.paint.png next to the library image.

def _save_png(img: Image.Image, target: str) -> None:
    tmp = target + ".tmp.png"
    img.save(tmp, "PNG", compress_level=1)
    os.replace(tmp, target)


def _cleanup_editor_folder(folder: str, keep_days: float = 2.0) -> None:
    import time
    limit = time.time() - keep_days * 86400
    try:
        for n in os.listdir(folder):
            p = os.path.join(folder, n)
            if n.startswith("clipspace-") and os.path.isfile(p) and os.path.getmtime(p) < limit:
                os.remove(p)
    except OSError:
        pass


def mask_editor_source(rel: str) -> dict:
    import folder_paths
    full = image_file(rel)
    st = os.stat(full)
    key = hashlib.sha1(
        f"{to_rel(full)}|{st.st_mtime_ns}|{st.st_size}|{_mtime(mask_path(full))}|{_mtime(paint_path(full))}"
        .encode("utf-8")).hexdigest()
    n = int(key[:13], 16)  # digits only: the MaskEditor parses the number
    folder = os.path.join(folder_paths.get_input_directory(), MASK_EDITOR_SUBFOLDER)
    names = {k: f"clipspace-{k}-{n}.png" for k in ("mask", "paint", "painted-masked")}
    if not all(os.path.isfile(os.path.join(folder, v)) for v in names.values()):
        os.makedirs(folder, exist_ok=True)
        _cleanup_editor_folder(folder)
        rgb, alpha = open_rgb_alpha(full)
        mask = load_mask(full, rgb.size)
        if mask is not None:
            alpha = Image.fromarray(255 - np.asarray(mask, dtype=np.uint8))
        elif alpha is None:
            alpha = Image.new("L", rgb.size, 255)
        paint = load_paint(full, rgb.size) or Image.new("RGBA", rgb.size, (0, 0, 0, 0))
        masked = rgb.copy()
        masked.putalpha(alpha)
        painted = Image.alpha_composite(rgb.convert("RGBA"), paint)
        painted.putalpha(alpha)
        _save_png(masked, os.path.join(folder, names["mask"]))
        _save_png(paint, os.path.join(folder, names["paint"]))
        _save_png(painted, os.path.join(folder, names["painted-masked"]))
    return {"filename": names["painted-masked"], "subfolder": MASK_EDITOR_SUBFOLDER, "type": "input"}


def import_mask_editor_result(rel: str, painted_filename: str, subfolder: str = "clipspace") -> dict:
    """
    Store the MaskEditor result as sidecar files (mask and colour layer).
    Returns {"mask": bool, "paint": bool}: whether each one is kept (empty ones are removed).
    """
    import folder_paths
    full = image_file(rel)
    m = _CLIPSPACE_PAINTED.match(painted_filename or "")
    sub = clean_rel(subfolder or "")
    # frontend 1.55 uploads the layers to input/ itself, older ones to input/clipspace
    if not m or sub not in ("", "clipspace"):
        raise LibraryError(f"Unexpected MaskEditor file: {sub}/{painted_filename}")
    base = os.path.join(folder_paths.get_input_directory(), sub)
    src = os.path.join(base, f"clipspace-mask-{m.group(1)}.png")
    if not os.path.isfile(src):
        raise LibraryError(f"MaskEditor mask not found: {src}")
    with Image.open(full) as orig:
        size = ImageOps.exif_transpose(orig).size

    with Image.open(src) as im:
        alpha = im.convert("RGBA").getchannel("A")
    mask_img = Image.fromarray(255 - np.asarray(alpha, dtype=np.uint8), "L")
    if mask_img.size != size:
        mask_img = mask_img.resize(size, Image.Resampling.BILINEAR)
    has_mask = bool(np.asarray(mask_img).any())
    if has_mask:
        _save_png(mask_img, mask_path(full))
    else:
        delete_mask(full)

    has_paint = False
    paint_src = os.path.join(base, f"clipspace-paint-{m.group(1)}.png")
    if os.path.isfile(paint_src):
        with Image.open(paint_src) as p:
            paint = p.convert("RGBA")
        if paint.size != size:
            paint = paint.resize(size, Image.Resampling.BILINEAR)
        has_paint = bool(np.asarray(paint.getchannel("A")).any())
        if has_paint:
            _save_png(paint, paint_path(full))
        else:
            delete_paint(full)
    return {"mask": has_mask, "paint": has_paint}


# ----------------------------------------------------------------------
# explorer
# ----------------------------------------------------------------------

def open_in_explorer(rel: str) -> None:
    full = resolve(rel)
    if not os.path.exists(full):
        raise LibraryError(f"Not found in the library: {rel!r}")
    if sys.platform == "win32":
        if os.path.isfile(full):
            subprocess.Popen(["explorer", "/select,", os.path.normpath(full)])
        else:
            os.startfile(os.path.normpath(full))  # noqa: S606 - local folder only
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", full] if os.path.isfile(full) else ["open", full])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(full) if os.path.isfile(full) else full])
