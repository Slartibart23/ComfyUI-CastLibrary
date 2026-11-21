"""
Cast Library: folder tree, listing, organising, sidecar files and thumbnails.

The library is a plain folder tree below ComfyUI's user directory
(``ComfyUI/user/cast_library``), folders can be nested freely. Workflows only
store paths relative to that root, so moving or reinstalling ComfyUI does not
break them. A new library starts with:

    cast_library/
    ├── #TEMP/
    ├── ACCESSORIES/
    ├── BACKGROUNDS/
    ├── CLOTHES/
    └── PERSONS/

Next to every image optional sidecar files can exist (same stem); moving or
deleting an image in the node takes them along:

    anna_01.png
    anna_01.mask.png    mask painted in ComfyUI's MaskEditor (white = masked)
    anna_01.paint.png   colour painted in the MaskEditor (RGBA, drawn over the image)
    anna_01.shape.json  rectangle / freehand shape drawn in the node preview
"""

import ctypes
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from io import BytesIO
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageOps

ROOT_NAME = "cast_library"
DEFAULT_FOLDERS = ("#TEMP", "ACCESSORIES", "BACKGROUNDS", "CLOTHES", "PERSONS")

IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif")
MASK_SUFFIX = ".mask.png"
PAINT_SUFFIX = ".paint.png"
SHAPE_SUFFIX = ".shape.json"
SIDECAR_SUFFIXES = (MASK_SUFFIX, PAINT_SUFFIX, SHAPE_SUFFIX)
THUMB_DIR = ".thumbs"
TRASH_DIR = ".trash"  # deleted files on systems without a reachable recycle bin
THUMB_SIZE = 320
MASK_EDITOR_SUBFOLDER = "cast_library"
# images dropped on a node without saving them in the library live in
# input/cast_library_drops and are addressed as "@drop/<file>"
DROP_PREFIX = "@drop"
DROPS_SUBFOLDER = "cast_library_drops"

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
    """Create the root folder; on first creation also the default folders."""
    root = root_dir()
    if not os.path.isdir(root):
        for name in DEFAULT_FOLDERS:
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


def drops_dir() -> str:
    import folder_paths
    return os.path.join(folder_paths.get_input_directory(), DROPS_SUBFOLDER)


def _inside(base: str, full: str) -> bool:
    try:
        return os.path.commonpath([base, full]) == base
    except ValueError:  # other drive
        return False


def resolve(rel: str) -> str:
    """Absolute path for a relative library path ('@drop/...' = dropped images); never leaves its base."""
    rel = clean_rel(rel)
    head, _, rest = rel.partition("/")
    if head == DROP_PREFIX:
        base, rel = os.path.abspath(drops_dir()), rest
        os.makedirs(base, exist_ok=True)
    else:
        base = os.path.abspath(ensure_root())
    full = os.path.abspath(os.path.join(base, *rel.split("/"))) if rel else base
    if not _inside(base, full):
        raise LibraryError(f"Invalid library path: {rel!r}")
    return full


def to_rel(full: str) -> str:
    full = os.path.abspath(full)
    root = os.path.abspath(root_dir())
    if not _inside(root, full):
        drops = os.path.abspath(drops_dir())
        if _inside(drops, full):
            rel = os.path.relpath(full, drops).replace("\\", "/")
            return DROP_PREFIX if rel == "." else f"{DROP_PREFIX}/{rel}"
    rel = os.path.relpath(full, root).replace("\\", "/")
    return "" if rel == "." else rel


def is_dropped(rel: str) -> bool:
    return clean_rel(rel).partition("/")[0] == DROP_PREFIX


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
    if name.lower() == DROP_PREFIX:
        raise LibraryError(f'"{DROP_PREFIX}" is reserved for dropped images.')
    return name


def image_file(rel: str) -> str:
    """Absolute path of an existing library image."""
    full = resolve(rel)
    if not os.path.isfile(full) or not is_image_name(os.path.basename(full)):
        raise LibraryError(f"Image not found in the library: {rel!r}")
    return full


def folder_dir(rel: str) -> str:
    """Absolute path of an existing library folder ('' = the library root)."""
    full = resolve(rel)
    if not os.path.isdir(full):
        raise LibraryError(f"Folder not found in the library: {rel!r}")
    return full


def describe(rel: str) -> Tuple[str, str]:
    """(folder path, folder name) of an image, e.g. ('PERSONS/Anna/Face', 'Face'); dropped images: ('', '')."""
    if is_dropped(rel):
        return "", ""
    folder = clean_rel(rel).rpartition("/")[0]
    return folder, folder.rpartition("/")[2]


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


def _folder_entry(full: str) -> dict:
    return {
        "path": to_rel(full),
        "name": os.path.basename(full),
        "count": len(_image_names(full)),
        "children": [_folder_entry(os.path.join(full, d)) for d in _subdirs(full)],
    }


def tree() -> dict:
    """The whole folder tree; the root entry has path '' and holds the top-level folders."""
    root = ensure_root()
    entry = _folder_entry(root)
    entry["name"] = "Cast Library"
    return {"root": root, "tree": entry}


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
    full = folder_dir(dir_rel)
    return [image_info(os.path.join(full, n)) for n in _image_names(full)]


# ----------------------------------------------------------------------
# organising: folders and images
# ----------------------------------------------------------------------

def _free_name(folder: str, stem: str, ext: str) -> str:
    """'stem.ext' in folder, or 'stem (n).ext' if taken (also by a sidecar of that stem)."""
    candidate, n = stem, 1
    while os.path.exists(os.path.join(folder, candidate + ext)) or any(
            os.path.exists(os.path.join(folder, candidate + s)) for s in SIDECAR_SUFFIXES):
        candidate = f"{stem} ({n})"
        n += 1
    return candidate


def _sidecars(image_full: str) -> List[str]:
    return [p for p in (mask_path(image_full), paint_path(image_full), shape_path(image_full)) if os.path.isfile(p)]


def _to_trash(paths: List[str]) -> None:
    """Move files / folders to the recycle bin (Windows) or the library's .trash folder."""
    if sys.platform == "win32":
        _windows_recycle(paths)
        return
    trash = os.path.join(ensure_root(), TRASH_DIR, time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(trash, exist_ok=True)
    for p in paths:
        stem, ext = os.path.splitext(os.path.basename(p))
        shutil.move(p, os.path.join(trash, _free_name(trash, stem, ext) + ext))


class _SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", ctypes.c_void_p),
        ("wFunc", ctypes.c_uint),
        ("pFrom", ctypes.c_wchar_p),
        ("pTo", ctypes.c_wchar_p),
        ("fFlags", ctypes.c_ushort),
        ("fAnyOperationsAborted", ctypes.c_int),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", ctypes.c_wchar_p),
    ]


def _windows_recycle(paths: List[str]) -> None:
    FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 3, 0x4, 0x10, 0x40, 0x400
    op = _SHFILEOPSTRUCTW()
    op.wFunc = FO_DELETE
    op.pFrom = "".join(os.path.abspath(p) + "\0" for p in paths) + "\0"
    op.fFlags = FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if result or op.fAnyOperationsAborted:
        raise LibraryError(f"Could not move to the recycle bin (error {result:#x}). Is a file open in another program?")


def create_folder(parent_rel: str, name: str) -> str:
    full = os.path.join(folder_dir(parent_rel), check_name(name))
    if os.path.exists(full):
        raise LibraryError(f'"{os.path.basename(full)}" already exists.')
    os.makedirs(full)
    return to_rel(full)


def _existing_folder(rel: str) -> str:
    if not clean_rel(rel) or is_dropped(rel):
        raise LibraryError("The library root itself cannot be changed.")
    return folder_dir(rel)


def rename_folder(rel: str, name: str) -> str:
    full = _existing_folder(rel)
    target = os.path.join(os.path.dirname(full), check_name(name))
    if os.path.normcase(target) != os.path.normcase(full) and os.path.exists(target):
        raise LibraryError(f'"{name.strip()}" already exists.')
    os.rename(full, target)
    return to_rel(target)


def move_folder(rel: str, target_rel: str) -> str:
    full = _existing_folder(rel)
    parent = folder_dir(target_rel)
    if os.path.normcase(parent) == os.path.normcase(full) or \
            os.path.normcase(parent).startswith(os.path.normcase(full) + os.sep):
        raise LibraryError("A folder cannot be moved into itself.")
    target = os.path.join(parent, os.path.basename(full))
    if os.path.normcase(target) == os.path.normcase(full):
        return to_rel(full)
    if os.path.exists(target):
        raise LibraryError(f'"{os.path.basename(full)}" already exists in the target folder.')
    shutil.move(full, target)
    return to_rel(target)


def delete_folder(rel: str) -> None:
    _to_trash([_existing_folder(rel)])


def move_images(rels: List[str], target_rel: str) -> Dict[str, str]:
    """Move images (with their sidecars) into a folder. Returns {old path: new path}."""
    target = folder_dir(target_rel)
    moved = {}
    for rel in rels:
        full = image_file(rel)
        if os.path.normcase(os.path.dirname(full)) == os.path.normcase(target):
            continue
        stem, ext = os.path.splitext(os.path.basename(full))
        new_stem = _free_name(target, stem, ext)
        for old in [full] + _sidecars(full):
            suffix = os.path.basename(old)[len(stem):]
            shutil.move(old, os.path.join(target, new_stem + suffix))
        moved[to_rel(full)] = to_rel(os.path.join(target, new_stem + ext))
    return moved


def delete_images(rels: List[str]) -> None:
    paths = []
    for rel in rels:
        full = image_file(rel)
        paths += [full] + _sidecars(full)
    if paths:
        _to_trash(paths)


# ----------------------------------------------------------------------
# upload
# ----------------------------------------------------------------------

def save_upload(dir_rel: str, filename: str, data: bytes) -> str:
    """Store an uploaded image in a library folder; never overwrites. Returns the relative path."""
    folder = folder_dir(dir_rel)
    base = os.path.basename((filename or "").replace("\\", "/")).strip()
    stem, ext = os.path.splitext(base)
    stem = _INVALID_NAME.sub("_", stem).strip(" .") or "image"
    ext = ext.lower()
    if ext not in IMAGE_EXTENSIONS:
        raise LibraryError(f"Not a supported image file: {base!r}")
    for marker in (".mask", ".paint"):  # would look like a sidecar file
        if stem.lower().endswith(marker):
            stem = stem[:-len(marker)] + "_" + marker[1:]
    try:
        with Image.open(BytesIO(data)) as im:
            im.verify()
    except Exception:
        raise LibraryError(f"The file is not a readable image: {base!r}") from None
    if is_dropped(dir_rel):
        # named by content: dropping the same image again reuses the file
        target = os.path.join(folder, f"{stem}_{hashlib.sha1(data).hexdigest()[:10]}{ext}")
        if os.path.isfile(target):
            return to_rel(target)
    else:
        target = os.path.join(folder, _free_name(folder, stem, ext) + ext)
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
