// "Cast Library · Load & Resize Image": folder picker, gallery, upload,
// Explorer button, preview with rectangle / freehand editor and the bridge to
// ComfyUI's MaskEditor (masks are stored next to the library image).

import {
  el, notify, getJSON, postJSON, libUrl, dirOf, baseOf, folderLabel, hasFiles, button,
  getTree, onTreeChange, flattenTree, onPathsMoved, uploadFiles, pickFiles, openInExplorer,
  newFolderDialog, openGallery,
} from "./cast_library_ui.js";
import { openComposer, parseComposition, renderComposition } from "./cast_library_compose.js";

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

const NODE_NAME = "CastLibrary_LoadImage";
const HANDLE = 7;
const FILL_CSS = {
  yellow: "#ffff00", red: "#ff0000", green: "#00ff00",
  blue: "#0000ff", white: "#ffffff", black: "#000000",
};
const CLIPSPACE_RESULT = /^clipspace-painted-masked-\d+\.png$/;
const MAX_SIDE = 2048; // same as MAX_SIDE in node.py

// size the node outputs before the optional resize (longest side at most MAX_SIDE)
function limitedSize(w, h) {
  const longest = Math.max(w, h);
  if (longest <= MAX_SIDE) return [w, h];
  const s = MAX_SIDE / longest;
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function parseData(text) {
  try {
    const d = typeof text === "string" ? JSON.parse(text || "{}") : text || {};
    return { rect: Array.isArray(d.rect) ? d.rect : null, strokes: Array.isArray(d.strokes) ? d.strokes : [] };
  } catch {
    return { rect: null, strokes: [] };
  }
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

async function fetchImage(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let err = `HTTP ${res.status}`;
    try { err = (await res.json()).error || err; } catch {}
    throw new Error(err);
  }
  const blob = await res.blob();
  const im = new Image();
  im.src = URL.createObjectURL(blob);
  try { await im.decode(); } finally { URL.revokeObjectURL(im.src); }
  return im;
}

app.registerExtension({
  name: "CastLibrary.LoadImage",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_NAME) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupNode(this);
      return r;
    };
  },
});

function setupNode(node) {
  const W = (name) => node.widgets?.find((w) => w.name === name);
  const pathWidget = W("library_image");
  const dataWidget = W("crop_data");
  if (!pathWidget || !dataWidget) return;
  pathWidget.hidden = true;
  dataWidget.hidden = true;
  const composeWidget = W("compose");
  const composeDataWidget = W("compose_data");
  if (composeDataWidget) composeDataWidget.hidden = true;
  const composing = () => !!composeWidget?.value && !!composeDataWidget;
  node.properties ??= {};

  // ------------------------------------------------------------------ DOM
  const wrapper = el("div", "display:flex;flex-direction:column;gap:4px;width:100%;height:100%;box-sizing:border-box;overflow:hidden;position:relative;");
  const pickRow = el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:4px;font:12px sans-serif;");
  const selCss = "flex:1 1 90px;min-width:70px;max-width:100%;padding:1px 2px;background:#222;color:#ddd;border:1px solid #555;border-radius:4px;font:12px sans-serif;";
  const folderSelect = el("select", selCss);
  folderSelect.title = "Folder for the gallery and for uploads";
  folderSelect.addEventListener("pointerdown", (e) => e.stopPropagation());
  folderSelect.addEventListener("wheel", (e) => e.stopPropagation());
  const bGallery = button("🖼 Gallery", "Open the library: pick, move and delete images, manage folders", () => showGallery(), "background:#2a6db0;");
  const bUpload = button("⬆", "Upload images into the selected folder (or drop files on the node)", async () => handleUpload(await pickFiles()));
  const bExplorer = button("📂", "Open the selected folder in Explorer", () => openInExplorer(currentDir()));
  const bNew = button("＋", "New folder inside the selected folder", async () => {
    const path = await newFolderDialog(currentDir());
    if (path) setDir(path);
  });
  const bCompose = button("🧩 Compose", "Arrange several library images into one picture", () => openCompose(), "background:#7a4ab0;");
  pickRow.append(folderSelect, bGallery, bCompose, bUpload, bExplorer, bNew);

  const bar = el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:4px;font:12px sans-serif;color:var(--input-text,#ddd);min-height:22px;");
  const info = el("div", "font:11px sans-serif;color:var(--descrip-text,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;");
  const canvasBox = el("div", "position:relative;flex:1 1 auto;min-height:80px;");
  const canvas = el("canvas", "position:absolute;inset:0;width:100%;height:100%;touch-action:none;");
  canvasBox.appendChild(canvas);
  const dropHint = el("div",
    "position:absolute;inset:0;border:2px dashed #4af;border-radius:6px;background:rgba(40,110,180,0.25);display:none;" +
    "align-items:center;justify-content:center;text-align:center;font:13px sans-serif;color:#fff;pointer-events:none;");
  wrapper.append(pickRow, bar, info, canvasBox, dropHint);

  const tools = { brush: null, lasso: null, erase: null };
  let tool = node.properties.castTool || "brush";
  let brushPx = node.properties.castBrush || 20;
  const toolButtons = el("span", "display:inline-flex;gap:4px;align-items:center;");
  tools.brush = button("Brush", "Paint the area to keep", () => setTool("brush"));
  tools.lasso = button("Lasso", "Draw an outline, it is filled when you release", () => setTool("lasso"));
  tools.erase = button("Eraser", "Remove painted area", () => setTool("erase"));
  const sizeInput = el("input", "width:70px;");
  Object.assign(sizeInput, { type: "range", min: 2, max: 150, value: brushPx, title: "Brush size" });
  sizeInput.addEventListener("pointerdown", (e) => e.stopPropagation());
  sizeInput.addEventListener("input", () => { brushPx = Number(sizeInput.value); node.properties.castBrush = brushPx; draw(); });
  const undoBtn = button("Undo", "Undo last stroke", () => { data.strokes.pop(); save(); });
  toolButtons.append(tools.brush, tools.lasso, tools.erase, sizeInput, undoBtn);
  const clearBtn = button("Clear", "Remove the rectangle / shape", () => {
    if (mode() === "rectangle") data.rect = null;
    else data.strokes = [];
    save();
  });
  const maskEditBtn = button("Mask Editor", "Paint a mask or colour in ComfyUI's MaskEditor; both are stored with the library image. " +
    "Colour is drawn into the output image in every mask_source mode", () => openMaskEditor());
  const maskDelBtn = button("Remove mask", "Delete the stored MaskEditor mask of this image", () => removeSidecar("mask"));
  const paintDelBtn = button("Remove paint", "Delete the colour painted in the MaskEditor for this image", () => removeSidecar("paint"));
  const modeHint = el("span", "font:11px sans-serif;color:var(--descrip-text,#999);");
  bar.append(toolButtons, clearBtn, maskEditBtn, maskDelBtn, paintDelBtn, modeHint);

  function setTool(t) {
    tool = t;
    node.properties.castTool = t;
    draw();
  }

  const uiWidget = node.addDOMWidget("cast_library_ui", "CastLibraryUI", wrapper, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => 260,
  });
  uiWidget.serialize = false; // keep it out of widgets_values
  setTimeout(() => {
    if (node.size[0] < 400 || node.size[1] < 680) {
      node.setSize([Math.max(node.size[0], 400), Math.max(node.size[1], 680)]);
    }
  }, 0);

  // ---------------------------------------------------------------- state
  let tree = null;
  let data = parseData(dataWidget.value);
  let lastDataValue = dataWidget.value;
  let current = null;       // { path, v, mask, shape } of the loaded library image
  let img = null;           // HTMLImageElement of that image
  let maskOverlay = null;   // red canvas of the stored MaskEditor mask
  let maskBounds = null;    // its bounding box [x, y, w, h], relative
  let paintLayer = null;    // colour painted in the MaskEditor (part of the output image)
  let message = "";
  let loadToken = 0;
  let wantedPath = null;    // path of the latest load request
  let singleInfo = "";      // info line for the single image
  let composeInfo = "";     // info line for the composition
  let composeCanvas = null; // rendered preview of the composition
  let composeToken = 0;
  let lastComposeData = null;
  let drag = null;
  let hover = null;
  let pendingShape = null;  // shape loaded from the library for a freshly picked image
  let meRef = null;         // temp copy shown to ComfyUI's MaskEditor
  let lastImported = "";

  const mode = () => W("mask_source")?.value || "MaskEditor";
  const currentDir = () => node.properties.castDir ?? dirOf(pathWidget.value);

  // ---------------------------------------------------------------- folder
  function setDir(dir) {
    node.properties.castDir = dir;
    renderSelects();
  }

  function renderSelects() {
    const folders = flattenTree(tree);
    let dir = currentDir();
    if (folders.length && node.properties.castDir == null && !pathWidget.value) {
      // nothing chosen yet: start with the first top-level folder (#TEMP)
      node.properties.castDir = dir = folders.find((f) => f.depth === 1)?.path ?? "";
    }
    folderSelect.textContent = "";
    for (const f of folders) {
      const label = `${"   ".repeat(f.depth)}${f.depth ? f.name : "🏠 Cast Library"}${f.count ? `  (${f.count})` : ""}`;
      folderSelect.appendChild(Object.assign(el("option", null, label), { value: f.path }));
    }
    if (!folders.some((f) => f.path === dir)) {
      folderSelect.appendChild(Object.assign(el("option", null, `${dir} (missing)`), { value: dir }));
    }
    folderSelect.value = dir;
  }

  folderSelect.addEventListener("change", () => setDir(folderSelect.value));

  async function refreshTree(force = false) {
    try {
      tree = await getTree(force);
    } catch (e) {
      message = `Library not reachable: ${e.message}`;
    }
    renderSelects();
  }
  const offTree = onTreeChange((t) => { tree = t; renderSelects(); });
  // images or folders were moved / renamed in a gallery: follow them
  const offMoved = onPathsMoved((remap) => {
    const path = pathWidget.value && remap(pathWidget.value);
    if (path) {
      pathWidget.value = path;
      wantedPath = path;
      if (current) current.path = path;
      meRef = null;
      prepareMaskEditor();
    }
    const dir = node.properties.castDir && remap(node.properties.castDir);
    if (dir) node.properties.castDir = dir;
    if (composeDataWidget?.value) {
      const comp = parseComposition(composeDataWidget.value);
      let hit = false;
      for (const l of comp.layers) { const np = remap(l.path); if (np) { l.path = np; hit = true; } }
      const bg = comp.background.image && remap(comp.background.image);
      if (bg) { comp.background.image = bg; hit = true; }
      if (hit) { composeDataWidget.value = JSON.stringify(comp); renderComposePreview(); }
    }
    node.setDirtyCanvas?.(true, true);
  });

  // ------------------------------------------------------------ compose
  function openCompose() {
    openComposer({
      data: parseComposition(composeDataWidget.value),
      startDir: currentDir(),
      onSave: (comp) => {
        composeDataWidget.value = JSON.stringify(comp);
        composeDataWidget.callback?.(composeDataWidget.value);
        renderComposePreview();
        node.setDirtyCanvas?.(true, true);
      },
    });
  }

  async function renderComposePreview() {
    lastComposeData = composeDataWidget.value;
    const comp = parseComposition(composeDataWidget.value);
    const token = ++composeToken;
    if (!comp.layers.length) {
      composeCanvas = null;
      composeInfo = "Composition is empty – click 🧩 Compose";
      draw();
      return;
    }
    const s = Math.min(1, 1024 / Math.max(comp.canvas.w, comp.canvas.h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(comp.canvas.w * s));
    c.height = Math.max(1, Math.round(comp.canvas.h * s));
    await renderComposition(c.getContext("2d"), comp, s);
    if (token !== composeToken) return;
    composeCanvas = c;
    composeInfo = `Composition: ${comp.layers.length} image(s) · output ${Math.round(comp.canvas.w)}×${Math.round(comp.canvas.h)}`;
    draw();
  }

  // ---------------------------------------------------------- picking
  async function pick(path) {
    pathWidget.value = path;
    pathWidget.callback?.(path);
    node.properties.castDir = dirOf(path);
    renderSelects();
    pendingShape = true; // take the shape stored with the image
    await loadCurrent(true);
    node.setDirtyCanvas?.(true, true);
  }

  function showGallery() {
    openGallery({
      startDir: currentDir(),
      current: pathWidget.value,
      onPick: (path) => pick(path),
      onDirChange: (dir) => setDir(dir),
    });
  }

  async function handleUpload(files) {
    if (!files?.length) return;
    try {
      const paths = await uploadFiles(currentDir(), files);
      notify(`${paths.length} image(s) added to ${folderLabel(currentDir())}`, "success");
      if (paths.length === 1) await pick(paths[0]);
    } catch (e) {
      notify(e.message);
    }
  }

  // ------------------------------------------------------- loading image
  async function loadCurrent(force = false) {
    const path = pathWidget.value || "";
    if (!force && wantedPath === path) return;
    wantedPath = path;
    const token = ++loadToken;
    if (!path) {
      current = null; img = null; maskOverlay = null; paintLayer = null; meRef = null;
      message = "No image – click 🖼 Gallery";
      singleInfo = "";
      setNodeImages(null);
      draw();
      return;
    }
    try {
      const inf = await getJSON("/info", { path });
      if (token !== loadToken) return;
      const sameImage = current?.path === path && current?.v === inf.v && img;
      current = { path, v: inf.v, mask: inf.mask, paint: inf.paint, shape: inf.shape };
      if (pendingShape) {
        pendingShape = null;
        data = parseData(inf.shape_data);
        writeData();
      }
      if (!sameImage) {
        const im = await fetchImage(libUrl("/view", { path, v: inf.v }));
        if (token !== loadToken) return;
        img = im;
      }
      message = "";
      const [ow, oh] = limitedSize(img.naturalWidth, img.naturalHeight);
      const scaled = ow !== img.naturalWidth ? `  → ${ow}×${oh}` : "";
      singleInfo = `${path.replaceAll("/", " › ")}  ${img.naturalWidth}×${img.naturalHeight}${scaled}`;
      info.title = path;
      await loadMaskOverlay(token);
      await loadPaintLayer(token);
      await prepareMaskEditor();
    } catch (e) {
      if (token !== loadToken) return;
      current = { path, v: "", mask: 0, paint: 0, shape: false };
      img = null; maskOverlay = null; paintLayer = null;
      message = String(e.message || e);
      singleInfo = path;
      setNodeImages(null);
    }
    draw();
  }


  async function loadMaskOverlay(token) {
    maskOverlay = null;
    maskBounds = null;
    if (!current?.mask || !img) return;
    try {
      const m = await fetchImage(libUrl("/mask", { path: current.path, v: current.mask }));
      if (token !== loadToken) return;
      const c = document.createElement("canvas");
      c.width = m.naturalWidth; c.height = m.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(m, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height);
      let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
      for (let i = 0; i < px.data.length; i += 4) {
        const a = px.data[i];
        if (a >= 128) {
          const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        px.data[i] = 255; px.data[i + 1] = 40; px.data[i + 2] = 40; px.data[i + 3] = a * 0.5;
      }
      ctx.putImageData(px, 0, 0);
      maskOverlay = c;
      // what crop_to_mask will cut out (relative)
      maskBounds = maxX < 0 ? null
        : [minX / c.width, minY / c.height, (maxX + 1 - minX) / c.width, (maxY + 1 - minY) / c.height];
    } catch {
      maskOverlay = null;
    }
  }

  async function loadPaintLayer(token) {
    paintLayer = null;
    if (!current?.paint || !img) return;
    try {
      const p = await fetchImage(libUrl("/paint", { path: current.path, v: current.paint }));
      if (token === loadToken) paintLayer = p;
    } catch {
      paintLayer = null;
    }
  }

  // ---------------------------------------------------------- MaskEditor
  // The MaskEditor reads node.images / node.imgs through ComfyUI's /view
  // route. It gets input/cast_library/clipspace-painted-masked-<n>.png, and
  // with it the stored mask and colour layer (see library.py). After saving
  // it points node.images at its own new clipspace files; those are imported
  // into <image>.mask.png / <image>.paint.png and our source is shown again.
  function setNodeImages(ref) {
    if (!ref) {
      node.images = undefined;
      node.imgs = undefined;
      return;
    }
    node.images = [{ ...ref }];
    const im = new Image();
    im.src = api.apiURL(`/view?${new URLSearchParams(ref)}`);
    node.imgs = [im];
    node.imageIndex = 0;
  }

  async function prepareMaskEditor() {
    if (!current?.path) return;
    try {
      meRef = await postJSON("/mask_editor/source", { path: current.path });
      setNodeImages(meRef);
    } catch (e) {
      meRef = null;
      console.warn("[CastLibrary] MaskEditor source:", e);
    }
  }

  function openMaskEditor() {
    if (!meRef || !node.imgs?.length) {
      notify("Pick an image first.");
      return;
    }
    try {
      app.canvas.selectNode(node);
      app.extensionManager.command.execute("Comfy.MaskEditor.OpenMaskEditor");
    } catch (e) {
      notify(`Could not open the MaskEditor: ${e.message || e}. Use right-click → Open in MaskEditor.`);
    }
  }

  async function importMaskEditorResult(ref) {
    const path = current?.path;
    if (!path) return;
    try {
      const res = await postJSON("/mask_editor/import", { path, filename: ref.filename, subfolder: ref.subfolder || "" });
      const parts = [];
      if (res.mask) parts.push(mode() === "MaskEditor" ? "mask" : "mask (used with mask_source = MaskEditor)");
      if (res.paint) parts.push("colour (part of the output image)");
      notify(parts.length ? `Stored with the library image: ${parts.join(", ")}` : "Nothing painted: stored mask and colour removed", "success");
    } catch (e) {
      notify(`MaskEditor result could not be stored: ${e.message}`);
    }
    await loadCurrent(true);
    app.graph?.setDirtyCanvas(true, true);
  }

  async function removeSidecar(kind) {
    if (!current?.path) return;
    try {
      await postJSON(`/${kind}/delete`, { path: current.path });
      notify(kind === "mask" ? "Mask removed" : "Colour removed", "success");
    } catch (e) {
      notify(e.message);
    }
    await loadCurrent(true);
  }

  function watchNodeImages() {
    const ref = node.images?.[0];
    // our own source has the same name pattern but lives in input/cast_library
    if (ref && CLIPSPACE_RESULT.test(ref.filename || "") && ref.subfolder !== meRef?.subfolder &&
        ref.filename !== lastImported) {
      lastImported = ref.filename;
      importMaskEditorResult(ref);
      return;
    }
    if (meRef && (node.images?.[0]?.filename !== meRef.filename || !node.imgs?.length)) setNodeImages(meRef);
  }

  // ------------------------------------------------------- crop data
  function writeData() {
    const clean = {};
    if (data.rect) clean.rect = data.rect.map((v) => Math.round(v * 1e5) / 1e5);
    if (data.strokes.length) clean.strokes = data.strokes;
    dataWidget.value = Object.keys(clean).length ? JSON.stringify(clean) : "";
    lastDataValue = dataWidget.value;
    return clean;
  }

  let shapeTimer = null;
  function save() {
    const clean = writeData();
    draw();
    node.setDirtyCanvas?.(true, true);
    const path = current?.path;
    if (!path) return;
    clearTimeout(shapeTimer);
    shapeTimer = setTimeout(() => {
      postJSON("/shape", { path, data: clean }).catch((e) => notify(`Shape not stored in the library: ${e.message}`));
    }, 400);
  }

  function syncFromWidget() {
    if (dataWidget.value !== lastDataValue) {
      lastDataValue = dataWidget.value;
      if (!drag) data = parseData(dataWidget.value);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------- geometry
  function imageBox() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!img || !cw || !ch) return null;
    const s = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  function toRel(e, box) {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.clientWidth / r.width, sy = canvas.clientHeight / r.height;
    const x = (e.clientX - r.left) * sx, y = (e.clientY - r.top) * sy;
    return { x, y, rx: (x - box.x) / box.w, ry: (y - box.y) / box.h };
  }

  function rectHandles(box) {
    const [x, y, w, h] = data.rect;
    const L = box.x + x * box.w, T = box.y + y * box.h, R = L + w * box.w, B = T + h * box.h;
    const mx = (L + R) / 2, my = (T + B) / 2;
    return { nw: [L, T], n: [mx, T], ne: [R, T], e: [R, my], se: [R, B], s: [mx, B], sw: [L, B], w: [L, my], L, T, R, B };
  }

  function hitRect(p, box) {
    if (!data.rect) return null;
    const hs = rectHandles(box);
    for (const k of ["nw", "ne", "se", "sw", "n", "e", "s", "w"]) {
      const [hx, hy] = hs[k];
      if (Math.abs(p.x - hx) <= HANDLE + 3 && Math.abs(p.y - hy) <= HANDLE + 3) return k;
    }
    if (p.x > hs.L && p.x < hs.R && p.y > hs.T && p.y < hs.B) return "move";
    return null;
  }

  const CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", move: "move" };

  // ------------------------------------------------------------ drawing
  function paintStrokes(ctx, box, strokes) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const st of strokes) {
      const pts = st.p || [];
      if (!pts.length) continue;
      ctx.globalCompositeOperation = st.t === "erase" ? "destination-out" : "source-over";
      ctx.fillStyle = ctx.strokeStyle = "#fff";
      if (st.t === "lasso") {
        if (pts.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(box.x + pts[0][0] * box.w, box.y + pts[0][1] * box.h);
        for (const q of pts.slice(1)) ctx.lineTo(box.x + q[0] * box.w, box.y + q[1] * box.h);
        ctx.closePath();
        ctx.fill();
        continue;
      }
      ctx.lineWidth = Math.max(1, (st.s || 0.02) * box.w);
      ctx.beginPath();
      ctx.moveTo(box.x + pts[0][0] * box.w, box.y + pts[0][1] * box.h);
      if (pts.length === 1) ctx.lineTo(box.x + pts[0][0] * box.w + 0.01, box.y + pts[0][1] * box.h);
      for (const q of pts.slice(1)) ctx.lineTo(box.x + q[0] * box.w, box.y + q[1] * box.h);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function drawComposition() {
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!composeCanvas) {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(composeInfo || "Loading…", cw / 2, ch / 2);
      return;
    }
    const s = Math.min(cw / composeCanvas.width, ch / composeCanvas.height);
    const w = composeCanvas.width * s, h = composeCanvas.height * s;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(composeCanvas, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  const shapeCanvas = document.createElement("canvas");
  const tintCanvas = document.createElement("canvas");

  function draw() {
    const m = mode();
    const comp = composing();
    bar.style.display = comp ? "none" : "flex";
    bCompose.style.display = comp ? "" : "none";
    info.textContent = comp ? composeInfo : singleInfo;
    if (comp) {
      drawComposition();
      return;
    }
    toolButtons.style.display = m === "freehand" ? "inline-flex" : "none";
    clearBtn.style.display = m === "rectangle" || m === "freehand" ? "" : "none";
    maskEditBtn.style.display = img ? "" : "none";
    maskDelBtn.style.display = m === "MaskEditor" && current?.mask ? "" : "none";
    paintDelBtn.style.display = current?.paint ? "" : "none";
    modeHint.textContent = {
      MaskEditor: current?.mask ? "stored mask shown in red" : "",
      rectangle: "Drag to draw, drag edges/corners to adjust",
      freehand: "",
    }[m] ?? "";
    for (const [k, b] of Object.entries(tools)) b.style.background = k === tool ? "#2a6db0" : "#333";

    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const box = imageBox();
    if (!box) {
      ctx.fillStyle = "#888";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(message || "Loading…", cw / 2, ch / 2);
      return;
    }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, box.x, box.y, box.w, box.h);
    if (paintLayer) ctx.drawImage(paintLayer, box.x, box.y, box.w, box.h);

    if (m === "MaskEditor" && maskOverlay) ctx.drawImage(maskOverlay, box.x, box.y, box.w, box.h);
    if (m === "MaskEditor" && maskBounds && W("crop_to_mask")?.value) {
      const [x, y, w, h] = maskBounds;
      ctx.strokeStyle = "#4af";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(box.x + x * box.w, box.y + y * box.h, w * box.w, h * box.h);
      ctx.setLineDash([]);
      label(ctx, `crop ${Math.round(w * img.naturalWidth)}×${Math.round(h * img.naturalHeight)}`, box.x + x * box.w + 4, box.y + y * box.h + 4);
    }

    if (m === "rectangle" && data.rect) {
      const hs = rectHandles(box);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.rect(hs.L, hs.T, hs.R - hs.L, hs.B - hs.T);
      ctx.fill("evenodd");
      ctx.strokeStyle = "#4af";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hs.L, hs.T, hs.R - hs.L, hs.B - hs.T);
      ctx.fillStyle = "#4af";
      for (const k of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
        const [hx, hy] = hs[k];
        ctx.fillRect(hx - HANDLE / 2 - 1, hy - HANDLE / 2 - 1, HANDLE + 2, HANDLE + 2);
      }
      const pw = Math.round(data.rect[2] * img.naturalWidth), ph = Math.round(data.rect[3] * img.naturalHeight);
      label(ctx, `${pw}×${ph}`, hs.L + 4, hs.T + 4);
    }

    if (m === "freehand") {
      for (const c of [shapeCanvas, tintCanvas]) { c.width = canvas.width; c.height = canvas.height; }
      const sctx = shapeCanvas.getContext("2d");
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintStrokes(sctx, box, drag?.stroke ? [...data.strokes, drag.stroke] : data.strokes);

      const fill = FILL_CSS[W("fill_color")?.value] || FILL_CSS.yellow;
      const tctx = tintCanvas.getContext("2d");
      tctx.globalAlpha = 0.65;
      tctx.fillStyle = fill;
      tctx.fillRect(box.x * dpr, box.y * dpr, box.w * dpr, box.h * dpr);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = "destination-out";
      tctx.drawImage(shapeCanvas, 0, 0);
      tctx.globalCompositeOperation = "source-over";

      const bb = drag ? null : shapeBounds(sctx, box, dpr);
      if (bb || drag) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(tintCanvas, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      if (bb) {
        ctx.strokeStyle = "#4af";
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bb.x, bb.y, bb.w, bb.h);
        ctx.setLineDash([]);
        const pw = Math.round((bb.w / box.w) * img.naturalWidth), ph = Math.round((bb.h / box.h) * img.naturalHeight);
        label(ctx, `${pw}×${ph}`, bb.x + 4, bb.y + 4);
      }
      if (drag?.stroke?.t === "lasso" && drag.stroke.p.length > 1) {
        const pts = drag.stroke.p;
        ctx.strokeStyle = "#fff";
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(box.x + pts[0][0] * box.w, box.y + pts[0][1] * box.h);
        for (const q of pts.slice(1)) ctx.lineTo(box.x + q[0] * box.w, box.y + q[1] * box.h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (hover && tool !== "lasso") {
        ctx.strokeStyle = tool === "erase" ? "#f66" : "#fff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(hover.x, hover.y, brushPx / 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function label(ctx, text, x, y) {
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const w = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(x - 2, y - 1, w + 4, 14);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x, y);
  }

  function shapeBounds(sctx, box, dpr) {
    const x0 = Math.floor(box.x * dpr), y0 = Math.floor(box.y * dpr);
    const w = Math.ceil(box.w * dpr), h = Math.ceil(box.h * dpr);
    if (w < 1 || h < 1) return null;
    const px = sctx.getImageData(x0, y0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 127) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: (x0 + minX) / dpr, y: (y0 + minY) / dpr, w: (maxX - minX + 1) / dpr, h: (maxY - minY + 1) / dpr };
  }

  // ------------------------------------------------------------ pointer
  canvas.addEventListener("pointerdown", (e) => {
    if (composing()) {
      if (e.button === 0) { e.stopPropagation(); openCompose(); }
      return;
    }
    const m = mode();
    const box = imageBox();
    if (!box || e.button !== 0) return;
    if (m !== "rectangle" && m !== "freehand") {
      if (!img) { e.stopPropagation(); showGallery(); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);
    const p = toRel(e, box);
    if (m === "rectangle") {
      const hit = hitRect(p, box);
      if (hit) {
        drag = { type: hit, start: p, rect: [...data.rect] };
      } else {
        const rx = clamp01(p.rx), ry = clamp01(p.ry);
        data.rect = [rx, ry, 0, 0];
        drag = { type: "se", start: { ...p, rx, ry }, rect: [rx, ry, 0, 0] };
      }
    } else {
      const pt = [clamp01(p.rx), clamp01(p.ry)];
      drag = { type: "stroke", stroke: { t: tool, s: brushPx / box.w, p: [pt] } };
      if (tool === "lasso") delete drag.stroke.s;
    }
    draw();
  });

  canvas.addEventListener("pointermove", (e) => {
    const box = imageBox();
    if (!box) return;
    const p = toRel(e, box);
    hover = { x: p.x, y: p.y };
    const m = mode();
    if (!drag) {
      if (m === "rectangle") canvas.style.cursor = CURSORS[hitRect(p, box)] || "crosshair";
      else canvas.style.cursor = m === "freehand" ? (tool === "lasso" ? "crosshair" : "none") : "default";
      if (m === "freehand") draw();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (drag.type === "stroke") {
      const pts = drag.stroke.p;
      const pt = [clamp01(p.rx), clamp01(p.ry)];
      const last = pts[pts.length - 1];
      if (Math.hypot((pt[0] - last[0]) * box.w, (pt[1] - last[1]) * box.h) >= 1.5) pts.push(pt);
      draw();
      return;
    }
    let [x, y, w, h] = drag.rect;
    const dx = p.rx - drag.start.rx, dy = p.ry - drag.start.ry;
    if (drag.type === "move") {
      x = Math.min(Math.max(x + dx, 0), 1 - w);
      y = Math.min(Math.max(y + dy, 0), 1 - h);
    } else {
      let L = x, T = y, R = x + w, B = y + h;
      if (drag.type.includes("w")) L = clamp01(L + dx);
      if (drag.type.includes("e")) R = clamp01(R + dx);
      if (drag.type.includes("n")) T = clamp01(T + dy);
      if (drag.type.includes("s")) B = clamp01(B + dy);
      x = Math.min(L, R); y = Math.min(T, B);
      w = Math.abs(R - L); h = Math.abs(B - T);
    }
    data.rect = [x, y, w, h];
    draw();
  });

  const endDrag = (e) => {
    if (!drag) return;
    e.stopPropagation();
    if (drag.type === "stroke") {
      const st = drag.stroke;
      if (st.t !== "lasso" || st.p.length >= 3) {
        st.p = st.p.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
        if (st.s) st.s = Math.round(st.s * 1e4) / 1e4;
        data.strokes.push(st);
      }
    } else if (data.rect && img && (data.rect[2] * img.naturalWidth < 2 || data.rect[3] * img.naturalHeight < 2)) {
      data.rect = drag.type === "se" && drag.rect[2] === 0 ? null : drag.rect;
    }
    drag = null;
    save();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => { hover = null; if (!drag) draw(); });

  // right-click on the preview opens the node menu (with "Open in MaskEditor")
  canvasBox.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    app.canvas.adjustMouseEvent?.(e);
    app.canvas.processContextMenu(node, e);
  });

  // ------------------------------------------------------- drag & drop upload
  let dragDepth = 0;
  const showDrop = (on) => {
    dropHint.style.display = on ? "flex" : "none";
    dropHint.textContent = `Add to ${folderLabel(currentDir()).replaceAll("/", " › ")}`;
  };
  wrapper.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; showDrop(true); });
  wrapper.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.stopPropagation(); } });
  wrapper.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; showDrop(false); } });
  wrapper.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    showDrop(false);
    handleUpload(e.dataTransfer.files);
  });
  // files dropped on the node outside the DOM part
  node.onDragOver = (e) => hasFiles(e);
  node.onDragDrop = (e) => {
    if (!hasFiles(e)) return false;
    handleUpload(e.dataTransfer.files);
    return true;
  };

  // ------------------------------------------------------------ updates
  new ResizeObserver(() => draw()).observe(canvasBox);

  // keep ComfyUI's own image preview away (we draw the image ourselves)
  const PREVIEW = "$$canvas-image-preview";
  function hideDefaultPreview() {
    const pw = node.widgets?.find((w) => w.name === PREVIEW);
    if (!pw) {
      node.addCustomWidget({
        name: PREVIEW, type: "cast_hidden_preview", value: "", hidden: true,
        serialize: false, options: { serialize: false },
        draw() {}, computeSize: () => [0, -4],
      });
    } else if (!pw.hidden) {
      pw.hidden = true;
      pw.computeSize = () => [0, -4];
      node.setDirtyCanvas?.(true, true);
    }
  }
  hideDefaultPreview();

  let lastLook = "";
  const timer = setInterval(() => {
    if (!node.graph) return;
    hideDefaultPreview();
    watchNodeImages();
    const changed = syncFromWidget();
    if ((pathWidget.value || "") !== wantedPath) {
      if (pathWidget.value && dirOf(pathWidget.value) !== node.properties.castDir) setDir(dirOf(pathWidget.value));
      loadCurrent();
    }
    if (composeDataWidget && composeDataWidget.value !== lastComposeData) renderComposePreview();
    const look = `${mode()}|${W("fill_color")?.value}|${W("crop_to_mask")?.value}|${composing()}|${current?.mask}|${current?.paint}`;
    if (changed || look !== lastLook) {
      lastLook = look;
      draw();
    }
  }, 300);

  // files may have been changed in Explorer meanwhile
  const onFocus = () => {
    refreshTree(true);
    if (current?.path) loadCurrent(true);
  };
  window.addEventListener("focus", onFocus);

  const onConfigure = node.onConfigure;
  node.onConfigure = function () {
    const r = onConfigure?.apply(this, arguments);
    // workflows saved with 1.1.x stored the preview widget's "" where crop_to_mask is now
    const crop = W("crop_to_mask");
    if (crop && typeof crop.value !== "boolean") crop.value = true;
    if (composeWidget && typeof composeWidget.value !== "boolean") composeWidget.value = false;
    data = parseData(dataWidget.value);
    lastDataValue = dataWidget.value;
    if (pathWidget.value) node.properties.castDir = dirOf(pathWidget.value);
    renderSelects();
    return r;
  };

  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    clearInterval(timer);
    window.removeEventListener("focus", onFocus);
    offTree();
    offMoved();
    return onRemoved?.apply(this, arguments);
  };

  setTool(tool);
  refreshTree();
  loadCurrent(true);
}
