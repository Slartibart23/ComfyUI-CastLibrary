"""
ComfyUI-CastLibrary
===================
An image library inside ComfyUI: persons (each with face / body areas, more
areas on demand), accessories, backgrounds and any other library you create.
Pick an image in the node's gallery, upload new ones, open the folder in
Explorer, and get image + mask (MaskEditor, rectangle or freehand) + resize.

Library folder: ComfyUI/user/cast_library (paths in workflows are relative).
"""

from .cast_library import library, routes
from .cast_library.node import NODE_ID, NODE_NAME, CastLibraryLoadImage

__version__ = "1.0.0"

NODE_CLASS_MAPPINGS = {NODE_ID: CastLibraryLoadImage}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_ID: NODE_NAME}
WEB_DIRECTORY = "./web"

try:
    library.ensure_root()
except Exception as e:  # never block ComfyUI start-up
    print(f"[CastLibrary] could not create the library folder: {e}")
routes.register()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
