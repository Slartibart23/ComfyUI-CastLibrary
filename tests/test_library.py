"""
Tests for the library helpers and the node.

Run from the ComfyUI folder with ComfyUI's Python, e.g.
    ..\\python_embeded\\python.exe -m unittest discover -s custom_nodes/ComfyUI-CastLibrary/tests -v
"""

import os
import shutil
import sys
import tempfile
import types
import unittest
from io import BytesIO

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)
COMFY = os.path.dirname(os.path.dirname(PACK))
sys.path.insert(0, PACK)
sys.path.insert(0, COMFY)

from cast_library import library as lib  # noqa: E402


def png_bytes(size=(64, 48), color=(200, 50, 50, 255), mode="RGBA"):
    buf = BytesIO()
    Image.new(mode, size, color[: len(mode)]).save(buf, "PNG")
    return buf.getvalue()


class LibraryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "user", "cast_library")
        lib.set_root(self.root)
        # minimal folder_paths stub for the MaskEditor bridge
        fp = types.ModuleType("folder_paths")
        fp.get_temp_directory = lambda: os.path.join(self.tmp, "temp")
        fp.get_input_directory = lambda: os.path.join(self.tmp, "input")
        fp.get_user_directory = lambda: os.path.join(self.tmp, "user")
        self._fp = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = fp

    def tearDown(self):
        lib.set_root(None)
        if self._fp is not None:
            sys.modules["folder_paths"] = self._fp
        else:
            sys.modules.pop("folder_paths", None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_defaults_and_tree(self):
        t = lib.tree()
        names = [(l["kind"], l["name"]) for l in t["libraries"]]
        self.assertEqual(names, [("library", "Accessories"), ("library", "Backgrounds")])
        self.assertTrue(os.path.isdir(os.path.join(self.root, "Persons")))

    def test_person_areas_upload_describe(self):
        self.assertEqual(lib.create_person("Anna"), "Persons/Anna")
        with self.assertRaises(lib.LibraryError):
            lib.create_person("Anna")
        self.assertEqual(lib.create_area("Persons/Anna", "Outfits"), "Persons/Anna/Outfits")
        anna = next(l for l in lib.tree()["libraries"] if l["name"] == "Anna")
        self.assertEqual(anna["kind"], "person")
        self.assertEqual([a["name"] for a in anna["areas"]], ["Face", "Body", "Outfits"])

        p1 = lib.save_upload("Persons/Anna/Face", "face.png", png_bytes())
        p2 = lib.save_upload("Persons/Anna/Face", "face.png", png_bytes())
        self.assertEqual(p1, "Persons/Anna/Face/face.png")
        self.assertEqual(p2, "Persons/Anna/Face/face (1).png")
        self.assertEqual(lib.describe(p1), ("Anna", "Face"))
        self.assertEqual(lib.describe("Accessories/hat.png"), ("Accessories", ""))
        imgs = lib.list_images("Persons/Anna/Face")
        self.assertEqual([i["name"] for i in imgs], ["face.png", "face (1).png"])
        self.assertTrue(os.path.isfile(lib.thumbnail(p1)))

    def test_rejects_bad_paths_and_names(self):
        for bad in ("../x", "Persons/../../x", ".thumbs/a"):
            with self.assertRaises(lib.LibraryError):
                lib.resolve(bad)
        for bad in ("", "a/b", "con:", ".hidden", "Persons"):
            with self.assertRaises(lib.LibraryError):
                lib.create_library(bad)
        with self.assertRaises(lib.LibraryError):
            lib.save_upload("Accessories", "x.txt", b"hello")
        with self.assertRaises(lib.LibraryError):
            lib.save_upload("Accessories", "x.png", b"not an image")

    def test_shape_and_mask_editor_roundtrip(self):
        rel = lib.save_upload("Accessories", "hat.png", png_bytes((40, 30), mode="RGB"))
        full = lib.image_file(rel)
        lib.write_shape(full, {"rect": [0.1, 0.1, 0.5, 0.5]})
        self.assertEqual(lib.read_shape(full), {"rect": [0.1, 0.1, 0.5, 0.5]})
        self.assertTrue(lib.list_images("Accessories")[0]["shape"])
        lib.write_shape(full, {})
        self.assertFalse(os.path.exists(lib.shape_path(full)))

        # MaskEditor source without a mask: fully opaque
        ref = lib.mask_editor_source(rel)
        src = os.path.join(self.tmp, "temp", ref["subfolder"], ref["filename"])
        self.assertEqual(Image.open(src).getchannel("A").getextrema(), (255, 255))

        # simulate a MaskEditor save: left half painted (alpha 0)
        clip = os.path.join(self.tmp, "input", "clipspace")
        os.makedirs(clip)
        alpha = np.full((30, 40), 255, np.uint8)
        alpha[:, :20] = 0
        rgba = Image.new("RGB", (40, 30)).convert("RGBA")
        rgba.putalpha(Image.fromarray(alpha))
        rgba.save(os.path.join(clip, "clipspace-mask-123.png"))
        self.assertTrue(lib.import_mask_editor_result(rel, "clipspace-painted-masked-123.png"))
        mask = np.asarray(lib.load_mask(full, (40, 30)))
        self.assertEqual(mask[:, :20].min(), 255)
        self.assertEqual(mask[:, 20:].max(), 0)
        self.assertTrue(lib.list_images("Accessories")[0]["mask"])

        # the new source carries the mask in its alpha (masked = transparent)
        ref2 = lib.mask_editor_source(rel)
        self.assertNotEqual(ref, ref2)
        a2 = np.asarray(Image.open(os.path.join(self.tmp, "temp", ref2["subfolder"], ref2["filename"])).getchannel("A"))
        self.assertEqual(a2[:, :20].max(), 0)
        self.assertEqual(a2[:, 20:].min(), 255)

        with self.assertRaises(lib.LibraryError):
            lib.import_mask_editor_result(rel, "../evil.png")

        # an empty mask removes the sidecar (frontend 1.55: layers directly in input/)
        Image.new("RGBA", (40, 30), (0, 0, 0, 255)).save(os.path.join(self.tmp, "input", "clipspace-mask-124.png"))
        self.assertFalse(lib.import_mask_editor_result(rel, "clipspace-painted-masked-124.png", ""))
        self.assertIsNone(lib.load_mask(full, (40, 30)))

    def test_node_outputs(self):
        try:
            from cast_library.node import CastLibraryLoadImage
        except Exception as e:  # torch / comfy not importable outside ComfyUI
            self.skipTest(f"node import failed: {e}")
        lib.create_person("Tom")
        rel = lib.save_upload("Persons/Tom/Body", "body.png", png_bytes((50, 40), mode="RGB"))
        full = lib.image_file(rel)
        Image.fromarray(np.pad(np.full((40, 25), 255, np.uint8), ((0, 0), (0, 25)))).save(lib.mask_path(full))
        node = CastLibraryLoadImage()
        self.assertIs(CastLibraryLoadImage.VALIDATE_INPUTS(library_image=rel), True)
        self.assertIsInstance(CastLibraryLoadImage.VALIDATE_INPUTS(library_image=""), str)

        img, mask, w, h, fname, name, area = node.load_image(rel, False, 512, 512, False, 32, "lanczos")
        self.assertEqual(tuple(img.shape), (1, 40, 50, 3))
        self.assertEqual((w, h, fname, name, area), (50, 40, "body", "Tom", "Body"))
        self.assertEqual(float(mask[0, :, :25].min()), 1.0)
        self.assertEqual(float(mask[0, :, 25:].max()), 0.0)

        img, mask, w, h, *_ = node.load_image(rel, True, 64, 64, False, 32, "bilinear", "rectangle",
                                              "yellow", '{"rect":[0,0,0.5,0.5]}')
        self.assertEqual((w, h), (64, 64))
        self.assertEqual(tuple(mask.shape), (1, 64, 64))
        self.assertGreater(float(mask[0, :32, :32].mean()), 0.9)
        self.assertLess(float(mask[0, 32:, 32:].mean()), 0.1)


    def test_large_images_are_scaled_to_2048(self):
        try:
            from cast_library.node import CastLibraryLoadImage, MAX_SIDE
        except Exception as e:
            self.skipTest(f"node import failed: {e}")
        self.assertEqual(MAX_SIDE, 2048)
        node = CastLibraryLoadImage()
        cases = [((3000, 1000), (2048, 683)), ((1200, 4096), (600, 2048)), ((2048, 1024), (2048, 1024)),
                 ((800, 600), (800, 600))]
        for (w, h), expected in cases:
            rel = lib.save_upload("Backgrounds", f"bg_{w}x{h}.png", png_bytes((w, h), mode="RGB"))
            if w == 3000:
                # mask on the left third, must survive the downscale
                m = np.zeros((h, w), np.uint8)
                m[:, :1000] = 255
                Image.fromarray(m).save(lib.mask_path(lib.image_file(rel)))
            img, mask, ow, oh, *_ = node.load_image(rel, False, 512, 512, False, 32, "lanczos")
            self.assertEqual((ow, oh), expected, (w, h))
            self.assertEqual(tuple(img.shape), (1, expected[1], expected[0], 3))
            self.assertEqual(tuple(mask.shape), (1, expected[1], expected[0]))
            self.assertLessEqual(float(img.max()), 1.0)
            if w == 3000:
                self.assertGreater(float(mask[0, :, :600].mean()), 0.99)
                self.assertLess(float(mask[0, :, 750:].mean()), 0.01)

        # the optional resize still works on top of the limit
        rel = "Backgrounds/bg_3000x1000.png"
        _, _, ow, oh, *_ = node.load_image(rel, True, 1024, 1024, True, 8, "bilinear")
        self.assertEqual((ow, oh), (1024, 336))


if __name__ == "__main__":
    unittest.main(verbosity=2)
