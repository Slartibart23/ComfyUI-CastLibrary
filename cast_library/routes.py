"""HTTP routes used by the node's web extension (all below /cast_library/)."""

import asyncio
import functools
import os

from aiohttp import web

from . import library as lib

PREFIX = "/cast_library"


def _run(fn, *args):
    """Run blocking file / PIL work off the event loop."""
    return asyncio.get_running_loop().run_in_executor(None, functools.partial(fn, *args))


def _error(e: Exception, status: int = 400):
    return web.json_response({"error": str(e)}, status=status)


def _handler(fn):
    @functools.wraps(fn)
    async def wrapped(request):
        try:
            return await fn(request)
        except lib.LibraryError as e:
            return _error(e)
        except FileNotFoundError as e:
            return _error(e, 404)
        except Exception as e:  # keep the UI informed instead of a bare 500
            print(f"[CastLibrary] {request.path}: {type(e).__name__}: {e}")
            return _error(e, 500)
    return wrapped


async def _json(request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise lib.LibraryError("Invalid request body") from None
    return data if isinstance(data, dict) else {}


def register() -> None:
    from server import PromptServer
    routes = PromptServer.instance.routes

    @routes.get(f"{PREFIX}/tree")
    @_handler
    async def tree(request):
        return web.json_response(await _run(lib.tree))

    @routes.get(f"{PREFIX}/images")
    @_handler
    async def images(request):
        rel = request.rel_url.query.get("dir", "")
        return web.json_response({"dir": lib.clean_rel(rel), "images": await _run(lib.list_images, rel)})

    @routes.get(f"{PREFIX}/info")
    @_handler
    async def info(request):
        rel = request.rel_url.query.get("path", "")
        full = lib.image_file(rel)
        data = await _run(lib.image_info, full)
        data["shape_data"] = await _run(lib.read_shape, full)
        return web.json_response(data)

    @routes.get(f"{PREFIX}/thumb")
    @_handler
    async def thumb(request):
        path = await _run(lib.thumbnail, request.rel_url.query.get("path", ""))
        return web.FileResponse(path, headers={"Cache-Control": "max-age=31536000, immutable"})

    @routes.get(f"{PREFIX}/view")
    @_handler
    async def view(request):
        full = lib.image_file(request.rel_url.query.get("path", ""))
        if full.lower().endswith((".tif", ".tiff")):
            # browsers can't show TIFF: send a PNG of the first frame
            def to_png():
                from io import BytesIO
                rgb, alpha = lib.open_rgb_alpha(full)
                if alpha is not None:
                    rgb.putalpha(alpha)
                buf = BytesIO()
                rgb.save(buf, "PNG", compress_level=1)
                return buf.getvalue()
            return web.Response(body=await _run(to_png), content_type="image/png",
                                headers={"Cache-Control": "no-cache"})
        return web.FileResponse(full, headers={"Cache-Control": "no-cache"})

    @routes.get(f"{PREFIX}/mask")
    @_handler
    async def mask(request):
        full = lib.image_file(request.rel_url.query.get("path", ""))
        mp = lib.mask_path(full)
        if not os.path.isfile(mp):
            return web.json_response({"error": "no mask"}, status=404)
        return web.FileResponse(mp, headers={"Cache-Control": "no-cache"})

    @routes.get(f"{PREFIX}/paint")
    @_handler
    async def paint(request):
        full = lib.image_file(request.rel_url.query.get("path", ""))
        pp = lib.paint_path(full)
        if not os.path.isfile(pp):
            return web.json_response({"error": "no paint"}, status=404)
        return web.FileResponse(pp, headers={"Cache-Control": "no-cache"})

    @routes.post(f"{PREFIX}/paint/delete")
    @_handler
    async def paint_delete(request):
        data = await _json(request)
        await _run(lib.delete_paint, lib.image_file(data.get("path", "")))
        return web.json_response({"ok": True})

    @routes.post(f"{PREFIX}/mask/delete")
    @_handler
    async def mask_delete(request):
        data = await _json(request)
        await _run(lib.delete_mask, lib.image_file(data.get("path", "")))
        return web.json_response({"ok": True})

    @routes.post(f"{PREFIX}/shape")
    @_handler
    async def shape(request):
        data = await _json(request)
        await _run(lib.write_shape, lib.image_file(data.get("path", "")), data.get("data") or {})
        return web.json_response({"ok": True})

    @routes.post(f"{PREFIX}/folder/create")
    @_handler
    async def folder_create(request):
        data = await _json(request)
        return web.json_response({"path": await _run(lib.create_folder, data.get("parent", ""), data.get("name", ""))})

    @routes.post(f"{PREFIX}/folder/rename")
    @_handler
    async def folder_rename(request):
        data = await _json(request)
        return web.json_response({"path": await _run(lib.rename_folder, data.get("path", ""), data.get("name", ""))})

    @routes.post(f"{PREFIX}/folder/move")
    @_handler
    async def folder_move(request):
        data = await _json(request)
        return web.json_response({"path": await _run(lib.move_folder, data.get("path", ""), data.get("target", ""))})

    @routes.post(f"{PREFIX}/folder/delete")
    @_handler
    async def folder_delete(request):
        data = await _json(request)
        await _run(lib.delete_folder, data.get("path", ""))
        return web.json_response({"ok": True})

    @routes.post(f"{PREFIX}/images/move")
    @_handler
    async def images_move(request):
        data = await _json(request)
        return web.json_response({"moved": await _run(lib.move_images, list(data.get("paths") or []), data.get("target", ""))})

    @routes.post(f"{PREFIX}/images/delete")
    @_handler
    async def images_delete(request):
        data = await _json(request)
        await _run(lib.delete_images, list(data.get("paths") or []))
        return web.json_response({"ok": True})

    @routes.post(f"{PREFIX}/upload")
    @_handler
    async def upload(request):
        reader = await request.multipart()
        folder, saved = None, []
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "dir":
                raw = bytes(await part.read(decode=False))
                try:
                    folder = raw.decode("utf-8").strip()
                except UnicodeDecodeError:  # some clients send the local code page
                    folder = raw.decode("cp1252", errors="replace").strip()
            elif part.name == "image":
                if folder is None:
                    raise lib.LibraryError("Upload: 'dir' must be sent before the files")
                data = await part.read(decode=False)
                saved.append(await _run(lib.save_upload, folder, part.filename or "image.png", bytes(data)))
        if not saved:
            raise lib.LibraryError("No image received")
        return web.json_response({"paths": saved})

    @routes.post(f"{PREFIX}/explorer")
    @_handler
    async def explorer(request):
        data = await _json(request)
        await _run(lib.open_in_explorer, data.get("path", ""))
        return web.json_response({"ok": True})

    @routes.post(f"{PREFIX}/mask_editor/source")
    @_handler
    async def mask_editor_source(request):
        data = await _json(request)
        return web.json_response(await _run(lib.mask_editor_source, data.get("path", "")))

    @routes.post(f"{PREFIX}/mask_editor/import")
    @_handler
    async def mask_editor_import(request):
        data = await _json(request)
        kept = await _run(lib.import_mask_editor_result, data.get("path", ""),
                          data.get("filename", ""), data.get("subfolder", ""))
        return web.json_response({"ok": True, **kept})
