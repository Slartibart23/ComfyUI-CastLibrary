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
        # deleting goes to a test trash instead of the real recycle bin
        self.trashed = []
        self._to_trash = lib._to_trash

        def fake_trash(paths):
            for path in paths:
                self.trashed.append(lib.to_rel(path))
                shutil.move(path, os.path.join(self.tmp, f"trash{len(self.trashed)}"))
        lib._to_trash = fake_trash

    def tearDown(self):
        lib.set_root(None)
        lib._to_trash = self._to_trash
        if self._fp is not None:
            sys.modules["folder_paths"] = self._fp
        else:
            sys.modules.pop("folder_paths", None)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_defaults_and_nested_tree(self):
        t = lib.tree()["tree"]
        self.assertEqual((t["path"], t["name"]), ("", "Cast Library"))
        self.assertEqual([c["name"] for c in t["children"]], ["#TEMP", "ACCESSORIES", "BACKGROUNDS", "CLOTHES", "PERSONS"])
        # any depth is listed (images used to vanish below the second level)
        deep = "PERSONS/Susanne/Gesicht/close"
        os.makedirs(lib.resolve(deep))
        p1 = lib.save_upload(deep, "face.png", png_bytes())
        p2 = lib.save_upload(deep, "face.png", png_bytes())
        self.assertEqual((p1, p2), (f"{deep}/face.png", f"{deep}/face (1).png"))
        node = lib.tree()["tree"]
        for name in deep.split("/"):
            node = next(c for c in node["children"] if c["name"] == name)
        self.assertEqual((node["path"], node["count"]), (deep, 2))
        self.assertEqual([i["name"] for i in lib.list_images(deep)], ["face.png", "face (1).png"])
        self.assertEqual(lib.describe(p1), (deep, "close"))
        self.assertEqual(lib.describe("hat.png"), ("", ""))
        self.assertTrue(os.path.isfile(lib.thumbnail(p1)))
        # an existing library is left as it is (no default folders added)
        lib.set_root(os.path.join(self.tmp, "other"))
        os.makedirs(os.path.join(self.tmp, "other", "Personen"))
        self.assertEqual([c["name"] for c in lib.tree()["tree"]["children"]], ["Personen"])

    def test_folder_management(self):
        self.assertEqual(lib.create_folder("PERSONS", "Anna"), "PERSONS/Anna")
        self.assertEqual(lib.create_folder("PERSONS/Anna", "Face"), "PERSONS/Anna/Face")
        self.assertEqual(lib.create_folder("", "EXTRA"), "EXTRA")
        with self.assertRaises(lib.LibraryError):
            lib.create_folder("PERSONS", "Anna")
        img = lib.save_upload("PERSONS/Anna/Face", "a.png", png_bytes())
        Image.new("L", (64, 48), 255).save(lib.mask_path(lib.image_file(img)))

        self.assertEqual(lib.rename_folder("PERSONS/Anna", "Anna B"), "PERSONS/Anna B")
        self.assertEqual(lib.rename_folder("PERSONS/Anna B", "anna b"), "PERSONS/anna b")  # case only
        self.assertEqual(lib.move_folder("PERSONS/anna b", "EXTRA"), "EXTRA/anna b")
        self.assertTrue(os.path.isfile(lib.mask_path(lib.image_file("EXTRA/anna b/Face/a.png"))))
        for bad in (lambda: lib.move_folder("EXTRA", "EXTRA/anna b"),   # into itself
                    lambda: lib.move_folder("EXTRA", "EXTRA"),
                    lambda: lib.rename_folder("", "x"),                 # root
                    lambda: lib.delete_folder(""),
                    lambda: lib.rename_folder("EXTRA", "PERSONS")):     # exists
            with self.assertRaises(lib.LibraryError):
                bad()
        self.assertEqual(lib.move_folder("EXTRA/anna b", "EXTRA"), "EXTRA/anna b")  # same place: no-op
        lib.delete_folder("EXTRA")
        self.assertEqual(self.trashed, ["EXTRA"])
        self.assertFalse(os.path.exists(lib.resolve("EXTRA")))

    def test_move_and_delete_images_with_sidecars(self):
        a = lib.save_upload("#TEMP", "a.png", png_bytes())
        full = lib.image_file(a)
        Image.new("L", (64, 48), 255).save(lib.mask_path(full))
        Image.new("RGBA", (64, 48)).save(lib.paint_path(full))
        lib.write_shape(full, {"rect": [0, 0, 1, 1]})
        lib.save_upload("PERSONS", "a.png", png_bytes())  # name taken in the target

        moved = lib.move_images([a], "PERSONS")
        self.assertEqual(moved, {"#TEMP/a.png": "PERSONS/a (1).png"})
        new_full = lib.image_file("PERSONS/a (1).png")
        for side in (lib.mask_path, lib.paint_path, lib.shape_path):
            self.assertTrue(os.path.isfile(side(new_full)))
        self.assertEqual(os.listdir(lib.resolve("#TEMP")), [])
        self.assertEqual(lib.move_images(["PERSONS/a (1).png"], "PERSONS"), {})  # same folder

        lib.delete_images(["PERSONS/a (1).png"])
        self.assertEqual(sorted(self.trashed), sorted(["PERSONS/a (1).png", "PERSONS/a (1).mask.png",
                                                       "PERSONS/a (1).paint.png", "PERSONS/a (1).shape.json"]))
        self.assertEqual([i["name"] for i in lib.list_images("PERSONS")], ["a.png"])
        with self.assertRaises(lib.LibraryError):
            lib.delete_images(["PERSONS/missing.png"])

    def test_rejects_bad_paths_and_names(self):
        for bad in ("../x", "PERSONS/../../x", ".thumbs/a"):
            with self.assertRaises(lib.LibraryError):
                lib.resolve(bad)
        for bad in ("", "a/b", "con:", ".hidden", "x" * 81):
            with self.assertRaises(lib.LibraryError):
                lib.create_folder("", bad)
        with self.assertRaises(lib.LibraryError):
            lib.save_upload("ACCESSORIES", "x.txt", b"hello")
        with self.assertRaises(lib.LibraryError):
            lib.save_upload("ACCESSORIES", "x.png", b"not an image")
        with self.assertRaises(lib.LibraryError):
            lib.save_upload("MISSING", "x.png", png_bytes())
        self.assertEqual(lib.save_upload("ACCESSORIES", "x.mask.png", png_bytes()), "ACCESSORIES/x_mask.png")

    def test_shape_and_mask_editor_roundtrip(self):
        rel = lib.save_upload("ACCESSORIES", "hat.png", png_bytes((40, 30), mode="RGB"))
        full = lib.image_file(rel)
        lib.write_shape(full, {"rect": [0.1, 0.1, 0.5, 0.5]})
        self.assertEqual(lib.read_shape(full), {"rect": [0.1, 0.1, 0.5, 0.5]})
        self.assertTrue(lib.list_images("ACCESSORIES")[0]["shape"])
        lib.write_shape(full, {})
        self.assertFalse(os.path.exists(lib.shape_path(full)))

        # MaskEditor source without mask / paint: fully opaque, empty colour layer,
        # in input/cast_library and named so that the MaskEditor loads its layers
        ref = lib.mask_editor_source(rel)
        self.assertEqual((ref["subfolder"], ref["type"]), ("cast_library", "input"))
        self.assertRegex(ref["filename"], r"^clipspace-painted-masked-\d+\.png$")
        n = ref["filename"][len("clipspace-painted-masked-"):-4]
        src_dir = os.path.join(self.tmp, "input", "cast_library")
        self.assertEqual(Image.open(os.path.join(src_dir, f"clipspace-mask-{n}.png")).getchannel("A").getextrema(), (255, 255))
        self.assertEqual(Image.open(os.path.join(src_dir, f"clipspace-paint-{n}.png")).getchannel("A").getextrema(), (0, 0))

        # simulate a MaskEditor save: left half masked (alpha 0), a red square painted
        clip = os.path.join(self.tmp, "input", "clipspace")
        os.makedirs(clip)
        alpha = np.full((30, 40), 255, np.uint8)
        alpha[:, :20] = 0
        rgba = Image.new("RGB", (40, 30)).convert("RGBA")
        rgba.putalpha(Image.fromarray(alpha))
        rgba.save(os.path.join(clip, "clipspace-mask-123.png"))
        paint = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
        paint.paste((255, 0, 0, 255), (30, 0, 40, 10))
        paint.save(os.path.join(clip, "clipspace-paint-123.png"))
        self.assertEqual(lib.import_mask_editor_result(rel, "clipspace-painted-masked-123.png"), {"mask": True, "paint": True})
        mask = np.asarray(lib.load_mask(full, (40, 30)))
        self.assertEqual(mask[:, :20].min(), 255)
        self.assertEqual(mask[:, 20:].max(), 0)
        info = lib.list_images("ACCESSORIES")[0]
        self.assertTrue(info["mask"] and info["paint"])
        self.assertEqual(lib.load_paint(full, (40, 30)).getpixel((35, 5)), (255, 0, 0, 255))
        self.assertTrue(os.path.isfile(lib.thumbnail(rel)))

        # the new source carries mask (alpha) and colour layer for re-editing
        ref2 = lib.mask_editor_source(rel)
        self.assertNotEqual(ref, ref2)
        n2 = ref2["filename"][len("clipspace-painted-masked-"):-4]
        a2 = np.asarray(Image.open(os.path.join(src_dir, f"clipspace-mask-{n2}.png")).getchannel("A"))
        self.assertEqual(a2[:, :20].max(), 0)
        self.assertEqual(a2[:, 20:].min(), 255)
        self.assertEqual(Image.open(os.path.join(src_dir, f"clipspace-paint-{n2}.png")).getpixel((35, 5)), (255, 0, 0, 255))

        with self.assertRaises(lib.LibraryError):
            lib.import_mask_editor_result(rel, "../evil.png")

        # empty mask and empty colour remove both sidecars (frontend 1.55: layers directly in input/)
        Image.new("RGBA", (40, 30), (0, 0, 0, 255)).save(os.path.join(self.tmp, "input", "clipspace-mask-124.png"))
        Image.new("RGBA", (40, 30), (0, 0, 0, 0)).save(os.path.join(self.tmp, "input", "clipspace-paint-124.png"))
        self.assertEqual(lib.import_mask_editor_result(rel, "clipspace-painted-masked-124.png", ""), {"mask": False, "paint": False})
        self.assertIsNone(lib.load_mask(full, (40, 30)))
        self.assertIsNone(lib.load_paint(full, (40, 30)))

    def test_multi_frame_file_loads_first_frame(self):
        try:
            from cast_library.node import CastLibraryLoadImage
        except Exception as e:
            self.skipTest(f"node import failed: {e}")
        # phone photos are MPO: a main image plus a smaller second frame
        main = Image.new("RGB", (80, 60), (255, 0, 0))
        extra = Image.new("RGB", (40, 30), (0, 255, 0))
        buf = BytesIO()
        main.save(buf, "MPO", save_all=True, append_images=[extra])
        with Image.open(BytesIO(buf.getvalue())) as check:
            self.assertEqual(getattr(check, "n_frames", 1), 2)
        rel = lib.save_upload("BACKGROUNDS", "phone.jpg", buf.getvalue())
        img, mask, w, h, *_ = CastLibraryLoadImage().load_image(rel, False, 512, 512, False, 32, "lanczos")
        self.assertEqual((tuple(img.shape), tuple(mask.shape), w, h), ((1, 60, 80, 3), (1, 60, 80), 80, 60))
        self.assertGreater(float(img[0, 30, 40, 0]), 0.9)

    def test_compose(self):
        try:
            from cast_library.node import CastLibraryLoadImage
        except Exception as e:
            self.skipTest(f"node import failed: {e}")
        import json
        red = lib.save_upload("PERSONS", "red.png", png_bytes((100, 200), color=(255, 0, 0, 255), mode="RGB"))
        blue = lib.save_upload("CLOTHES", "blue.png", png_bytes((100, 100), color=(0, 0, 255, 255), mode="RGB"))
        sky = lib.save_upload("BACKGROUNDS", "sky.png", png_bytes((50, 50), color=(0, 255, 0, 255), mode="RGB"))
        # half of a transparent cut-out shows what is below it
        cut = Image.new("RGBA", (40, 40), (255, 255, 0, 255))
        cut.paste((0, 0, 0, 0), (0, 0, 20, 40))
        buf = BytesIO()
        cut.save(buf, "PNG")
        cutout = lib.save_upload("ACCESSORIES", "cut.png", buf.getvalue())
        comp = {
            "canvas": {"w": 400, "h": 200},
            "background": {"color": "#ffffff", "image": None},
            "layers": [
                {"path": red, "x": 0, "y": 0, "w": 100, "h": 200, "crop": [0, 0, 1, 1]},
                # right half of the blue image, 50x100 shown as 100x200
                {"path": blue, "x": 200, "y": 0, "w": 100, "h": 200, "crop": [0.5, 0, 0.5, 1]},
                {"path": cutout, "x": 0, "y": 0, "w": 40, "h": 40, "crop": [0, 0, 1, 1]},
            ],
        }
        node = CastLibraryLoadImage()
        img, mask, w, h, fname, folder, folder_name = node.load_image(
            "", False, 512, 512, False, 32, "lanczos", compose=True, compose_data=json.dumps(comp))
        self.assertEqual((tuple(img.shape), w, h), ((1, 200, 400, 3), 400, 200))
        px = lambda x, y: [round(float(v), 2) for v in img[0, y, x]]
        self.assertEqual(px(50, 100), [1.0, 0.0, 0.0])     # red
        self.assertEqual(px(150, 100), [1.0, 1.0, 1.0])    # background between
        self.assertEqual(px(250, 100), [0.0, 0.0, 1.0])    # blue
        self.assertEqual(px(10, 20), [1.0, 0.0, 0.0])      # transparent half of the cut-out
        self.assertEqual(px(30, 20), [1.0, 1.0, 0.0])      # opaque half
        self.assertEqual(float(mask.max()), 0.0)
        self.assertEqual(fname, "red, blue, cut")
        self.assertEqual(folder, "PERSONS, CLOTHES, ACCESSORIES")
        self.assertEqual(folder_name, "PERSONS, CLOTHES, ACCESSORIES")

        # background image covers the canvas; larger canvases are limited to 2048 px
        comp["background"]["image"] = sky
        comp["canvas"] = {"w": 4000, "h": 2000}
        comp["layers"] = [{"path": red, "x": 0, "y": 0, "w": 1000, "h": 2000, "crop": [0, 0, 1, 1]}]
        img, _, w, h, *_ = node.load_image("", False, 512, 512, False, 32, "lanczos",
                                           compose=True, compose_data=json.dumps(comp))
        self.assertEqual((w, h), (2048, 1024))
        self.assertEqual([round(float(v), 2) for v in img[0, 500, 1500]], [0.0, 1.0, 0.0])
        self.assertEqual([round(float(v), 2) for v in img[0, 500, 200]], [1.0, 0.0, 0.0])

        self.assertIs(CastLibraryLoadImage.VALIDATE_INPUTS("", compose=True, compose_data=json.dumps(comp)), True)
        self.assertIsInstance(CastLibraryLoadImage.VALIDATE_INPUTS("", compose=True, compose_data=""), str)
        comp["layers"][0]["path"] = "PERSONS/missing.png"
        self.assertIsInstance(CastLibraryLoadImage.VALIDATE_INPUTS("", compose=True, compose_data=json.dumps(comp)), str)
        with self.assertRaises(ValueError):
            node.load_image("", False, 512, 512, False, 32, "lanczos", compose=True, compose_data="{}")

    def test_paint_goes_into_output_image(self):
        try:
            from cast_library.node import CastLibraryLoadImage
        except Exception as e:
            self.skipTest(f"node import failed: {e}")
        rel = lib.save_upload("BACKGROUNDS", "sky.png", png_bytes((40, 30), color=(0, 0, 255, 255), mode="RGB"))
        paint = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
        paint.paste((255, 0, 0, 255), (0, 0, 10, 10))
        paint.paste((0, 255, 0, 128), (20, 0, 30, 10))
        paint.save(lib.paint_path(lib.image_file(rel)))
        for mode in ("MaskEditor", "rectangle"):
            img, *_ = CastLibraryLoadImage().load_image(rel, False, 512, 512, False, 32, "lanczos", mode, "yellow", "")
            self.assertEqual([round(float(v), 2) for v in img[0, 5, 5]], [1.0, 0.0, 0.0])
            self.assertEqual([round(float(v), 2) for v in img[0, 5, 25]], [0.0, 0.5, 0.5])
            self.assertEqual([round(float(v), 2) for v in img[0, 20, 5]], [0.0, 0.0, 1.0])

    def test_node_outputs(self):
        try:
            from cast_library.node import CastLibraryLoadImage
        except Exception as e:  # torch / comfy not importable outside ComfyUI
            self.skipTest(f"node import failed: {e}")
        os.makedirs(lib.resolve("PERSONS/Tom/Body"))
        rel = lib.save_upload("PERSONS/Tom/Body", "body.png", png_bytes((50, 40), mode="RGB"))
        full = lib.image_file(rel)
        Image.fromarray(np.pad(np.full((40, 25), 255, np.uint8), ((0, 0), (0, 25)))).save(lib.mask_path(full))
        node = CastLibraryLoadImage()
        self.assertIs(CastLibraryLoadImage.VALIDATE_INPUTS(library_image=rel), True)
        self.assertIsInstance(CastLibraryLoadImage.VALIDATE_INPUTS(library_image=""), str)

        img, mask, w, h, fname, folder, folder_name = node.load_image(rel, False, 512, 512, False, 32, "lanczos",
                                                             crop_to_mask=False)
        self.assertEqual(tuple(img.shape), (1, 40, 50, 3))
        self.assertEqual((w, h, fname, folder, folder_name), (50, 40, "body", "PERSONS/Tom/Body", "Body"))
        self.assertEqual(float(mask[0, :, :25].min()), 1.0)
        self.assertEqual(float(mask[0, :, 25:].max()), 0.0)

        img, mask, w, h, *_ = node.load_image(rel, True, 64, 64, False, 32, "bilinear", "rectangle",
                                              "yellow", '{"rect":[0,0,0.5,0.5]}', False)
        self.assertEqual((w, h), (64, 64))
        self.assertEqual(tuple(mask.shape), (1, 64, 64))
        self.assertGreater(float(mask[0, :32, :32].mean()), 0.9)
        self.assertLess(float(mask[0, 32:, 32:].mean()), 0.1)

        # crop_to_mask (default on) cuts out the mask's bounding box, like Image Crop By Mask
        img, mask, w, h, *_ = node.load_image(rel, False, 512, 512, False, 32, "lanczos")
        self.assertEqual((tuple(img.shape), w, h), ((1, 40, 25, 3), 25, 40))
        self.assertEqual(float(mask.min()), 1.0)
        img, mask, w, h, *_ = node.load_image(rel, False, 512, 512, False, 32, "lanczos", "rectangle",
                                              "yellow", '{"rect":[0.2,0.25,0.4,0.5]}')
        self.assertEqual((w, h), (20, 20))
        # crop first, then resize the cut-out
        _, _, w, h, *_ = node.load_image(rel, True, 64, 64, False, 32, "bilinear", "rectangle",
                                         "yellow", '{"rect":[0.2,0.25,0.4,0.5]}')
        self.assertEqual((w, h), (64, 64))
        # without a mask nothing is cropped
        os.remove(lib.mask_path(full))
        _, mask, w, h, *_ = node.load_image(rel, False, 512, 512, False, 32, "lanczos")
        self.assertEqual((w, h, float(mask.max())), (50, 40, 0.0))

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
            rel = lib.save_upload("BACKGROUNDS", f"bg_{w}x{h}.png", png_bytes((w, h), mode="RGB"))
            if w == 3000:
                # mask on the left third, must survive the downscale
                m = np.zeros((h, w), np.uint8)
                m[:, :1000] = 255
                Image.fromarray(m).save(lib.mask_path(lib.image_file(rel)))
            img, mask, ow, oh, *_ = node.load_image(rel, False, 512, 512, False, 32, "lanczos", crop_to_mask=False)
            self.assertEqual((ow, oh), expected, (w, h))
            self.assertEqual(tuple(img.shape), (1, expected[1], expected[0], 3))
            self.assertEqual(tuple(mask.shape), (1, expected[1], expected[0]))
            self.assertLessEqual(float(img.max()), 1.0)
            if w == 3000:
                self.assertGreater(float(mask[0, :, :600].mean()), 0.99)
                self.assertLess(float(mask[0, :, 750:].mean()), 0.01)

        # the optional resize still works on top of the limit
        rel = "BACKGROUNDS/bg_3000x1000.png"
        _, _, ow, oh, *_ = node.load_image(rel, True, 1024, 1024, True, 8, "bilinear", crop_to_mask=False)
        self.assertEqual((ow, oh), (1024, 336))
        # with crop_to_mask the 1000x1000 cut-out stays below the limit
        _, _, ow, oh, *_ = node.load_image(rel, False, 512, 512, False, 32, "lanczos")
        self.assertEqual((ow, oh), (1000, 1000))


if __name__ == "__main__":
    unittest.main(verbosity=2)
