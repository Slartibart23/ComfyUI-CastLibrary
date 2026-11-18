// Cast Library composer: several library images on one canvas, arranged like
// "Stitch Images" (row / column / grid with spacing) or placed freely, scaled
// (aspect kept), cropped and stacked. The layout is stored as JSON in the
// node's compose_data widget (canvas pixels, crops relative to the image).

import { el, notify, getJSON, libUrl, baseOf, button, openGallery, modal, isTopOverlay } from "./cast_library_ui.js";

const MAX_SIDE = 2048; // same as MAX_SIDE in node.py
const HANDLE = 8;
const PRESETS = { "1:1": 1, "3:4": 3 / 4, "4:3": 4 / 3, "16:9": 16 / 9, "9:16": 9 / 16 };

export const emptyComposition = () => ({
  canvas: { w: 1536, h: 2048, preset: "3:4" },
  background: { color: "#ffffff", image: null },
  spacing: 16,
  layers: [],
});

export function parseComposition(text) {
  try {
    const d = JSON.parse(text || "");
    if (d && Array.isArray(d.layers) && d.canvas) return { ...emptyComposition(), ...d };
  } catch {}
  return emptyComposition();
}

// ---------------------------------------------------------------- images
const imageCache = new Map(); // path -> Promise<{ img, paint }>

async function fetchImage(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const im = new Image();
  im.src = URL.createObjectURL(await res.blob());
  try { await im.decode(); } finally { URL.revokeObjectURL(im.src); }
  return im;
}

export function loadLayerImage(path, force = false) {
  if (!force && imageCache.has(path)) return imageCache.get(path);
  const p = (async () => {
    const inf = await getJSON("/info", { path });
    const img = await fetchImage(libUrl("/view", { path, v: inf.v }));
    const paint = inf.paint ? await fetchImage(libUrl("/paint", { path, v: inf.paint })).catch(() => null) : null;
    return { img, paint };
  })();
  imageCache.set(path, p);
  p.catch(() => imageCache.delete(path));
  return p;
}

const natural = (entry) => [entry.img.naturalWidth, entry.img.naturalHeight];
const layerAspect = (layer, entry) => {
  const [w, h] = natural(entry);
  return (layer.crop[2] * w) / (layer.crop[3] * h);
};

// draws the composition into ctx at the given scale (canvas px -> ctx px)
export async function renderComposition(ctx, data, scale, ox = 0, oy = 0) {
  const entries = await Promise.all(data.layers.map((l) => loadLayerImage(l.path).catch(() => null)));
  const bg = data.background?.image ? await loadLayerImage(data.background.image).catch(() => null) : null;
  drawComposition(ctx, data, scale, ox, oy, entries, bg);
}

function drawComposition(ctx, data, scale, ox, oy, entries, bg) {
  const W = data.canvas.w * scale, H = data.canvas.h * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, W, H);
  ctx.clip();
  ctx.fillStyle = data.background?.color || "#ffffff";
  ctx.fillRect(ox, oy, W, H);
  if (bg) {
    const [bw, bh] = natural(bg);
    const s = Math.max(W / bw, H / bh); // cover
    for (const im of [bg.img, bg.paint]) {
      if (im) ctx.drawImage(im, ox + (W - bw * s) / 2, oy + (H - bh * s) / 2, bw * s, bh * s);
    }
  }
  ctx.imageSmoothingQuality = "high";
  data.layers.forEach((l, i) => {
    const e = entries[i];
    if (!e) return;
    const [nw, nh] = natural(e);
    const [cx, cy, cw, ch] = l.crop;
    for (const im of [e.img, e.paint]) {
      if (im) ctx.drawImage(im, cx * nw, cy * nh, cw * nw, ch * nh, ox + l.x * scale, oy + l.y * scale, l.w * scale, l.h * scale);
    }
  });
  ctx.restore();
}

// ---------------------------------------------------------------- layout
function presetSize(ratio) {
  return ratio >= 1 ? [MAX_SIDE, Math.round(MAX_SIDE / ratio)] : [Math.round(MAX_SIDE * ratio), MAX_SIDE];
}

function limitCanvas(w, h) {
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

// scale and center all layers from the old canvas size into the new one
function refitLayers(data, nw, nh) {
  const { w: ow, h: oh } = data.canvas;
  const s = Math.min(nw / ow, nh / oh);
  const dx = (nw - ow * s) / 2, dy = (nh - oh * s) / 2;
  for (const l of data.layers) Object.assign(l, { x: l.x * s + dx, y: l.y * s + dy, w: l.w * s, h: l.h * s });
  Object.assign(data.canvas, { w: nw, h: nh });
}

// "fit content": canvas = bounding box of the layers, at most MAX_SIDE
function fitCanvas(data) {
  if (!data.layers.length) return;
  const x0 = Math.min(...data.layers.map((l) => l.x)), y0 = Math.min(...data.layers.map((l) => l.y));
  const x1 = Math.max(...data.layers.map((l) => l.x + l.w)), y1 = Math.max(...data.layers.map((l) => l.y + l.h));
  for (const l of data.layers) { l.x -= x0; l.y -= y0; }
  const w = x1 - x0, h = y1 - y0;
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  if (s < 1) for (const l of data.layers) Object.assign(l, { x: l.x * s, y: l.y * s, w: l.w * s, h: l.h * s });
  Object.assign(data.canvas, { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) });
}

// like Stitch Images: same height in a row / same width in a column (aspect kept),
// or a grid of equal cells; spacing between the images shows the background
function arrange(data, entries, mode) {
  const n = data.layers.length;
  if (!n) return;
  const sp = data.spacing;
  const a = data.layers.map((l, i) => layerAspect(l, entries[i]));
  const fit = data.canvas.preset === "fit";
  const place = (l, x, y, w, h) => Object.assign(l, { x, y, w, h });

  if (mode === "row" || mode === "column") {
    const row = mode === "row";
    // sum of the varying side per unit of the common side
    const sum = row ? a.reduce((s, v) => s + v, 0) : a.reduce((s, v) => s + 1 / v, 0);
    const gaps = sp * (n - 1);
    let common;
    if (fit) {
      // longest side of the result becomes MAX_SIDE
      common = sum * MAX_SIDE + gaps > MAX_SIDE ? (MAX_SIDE - gaps) / sum : MAX_SIDE;
    } else {
      const along = row ? data.canvas.w : data.canvas.h, across = row ? data.canvas.h : data.canvas.w;
      common = Math.min(across, (along - gaps) / sum);
    }
    common = Math.max(1, common);
    let pos = 0;
    data.layers.forEach((l, i) => {
      const size = row ? a[i] * common : common / a[i];
      if (row) place(l, pos, 0, size, common); else place(l, 0, pos, common, size);
      pos += size + sp;
    });
  } else {
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const cellAspect = [...a].sort((p, q) => p - q)[Math.floor(n / 2)];
    let cw, chh;
    if (fit) {
      chh = cols * cellAspect >= rows ? (MAX_SIDE - sp * (cols - 1)) / (cols * cellAspect) : (MAX_SIDE - sp * (rows - 1)) / rows;
      cw = chh * cellAspect;
    } else {
      cw = (data.canvas.w - sp * (cols - 1)) / cols;
      chh = (data.canvas.h - sp * (rows - 1)) / rows;
    }
    data.layers.forEach((l, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      const s = Math.min(cw / a[i], chh); // contain in the cell
      const w = s * a[i], h = s;
      place(l, c * (cw + sp) + (cw - w) / 2, r * (chh + sp) + (chh - h) / 2, w, h);
    });
  }

  if (fit) {
    fitCanvas(data);
  } else {
    // center the block in the canvas
    const x0 = Math.min(...data.layers.map((l) => l.x)), y0 = Math.min(...data.layers.map((l) => l.y));
    const x1 = Math.max(...data.layers.map((l) => l.x + l.w)), y1 = Math.max(...data.layers.map((l) => l.y + l.h));
    const dx = (data.canvas.w - (x1 - x0)) / 2 - x0, dy = (data.canvas.h - (y1 - y0)) / 2 - y0;
    for (const l of data.layers) { l.x += dx; l.y += dy; }
  }
  data.arrange = mode;
}

// ---------------------------------------------------------------- window
/**
 * Opens the composer.
 *   data      composition (copied, the original is untouched until saved)
 *   startDir  folder the gallery opens in
 *   onSave(data)
 */
export async function openComposer({ data: initial, startDir, onSave }) {
  const data = JSON.parse(JSON.stringify(initial || emptyComposition()));
  const { overlay, panel } = modal("width:min(1500px,96vw);height:92vh;display:flex;flex-direction:column;overflow:hidden;");

  const inputCss = "padding:2px 4px;background:#111;color:#eee;border:1px solid #555;border-radius:4px;font:12px sans-serif;";
  const label = (t) => el("span", "color:#999;font-size:11px;", t);

  // ---- toolbar
  const bar = el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid #444;");
  const presetSel = el("select", inputCss);
  for (const p of [...Object.keys(PRESETS), "fit", "custom"]) {
    presetSel.appendChild(Object.assign(el("option", null, p === "fit" ? "fit content" : p), { value: p }));
  }
  const wIn = el("input", inputCss + "width:62px;");
  const hIn = el("input", inputCss + "width:62px;");
  for (const i of [wIn, hIn]) Object.assign(i, { type: "number", min: 16, max: MAX_SIDE });
  const spIn = el("input", inputCss + "width:52px;");
  Object.assign(spIn, { type: "number", min: 0, max: 512, value: data.spacing });
  const colorIn = el("input", "width:34px;height:22px;padding:0;border:1px solid #555;background:none;");
  Object.assign(colorIn, { type: "color", value: data.background.color || "#ffffff" });
  colorIn.title = "Background colour (also the colour of the spacing)";
  const bgName = el("span", "color:#ccc;font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
  const bBg = button("Background image…", "Fill the canvas with a library image", () => pickBackground());
  const bBgClear = button("×", "Remove the background image", () => { data.background.image = null; changed(); });
  const sizeInfo = el("span", "color:#9ab;font-size:12px;margin-left:auto;");
  const bDone = button("Done", "Use this composition", () => { close(); onSave?.(data); }, "background:#2a6db0;");
  const bCancel = button("Cancel", "Discard the changes", () => close());
  bar.append(
    label("Canvas"), presetSel, wIn, el("span", null, "×"), hIn,
    label("Arrange"),
    button("▭▭ Row", "Side by side, same height (like Stitch Images → right)", () => doArrange("row")),
    button("▤ Column", "Stacked, same width (like Stitch Images → down)", () => doArrange("column")),
    button("▦ Grid", "Equal cells", () => doArrange("grid")),
    label("Spacing"), spIn,
    label("Background"), colorIn, bBg, bgName, bBgClear,
    sizeInfo, bCancel, bDone,
  );

  // ---- stage + layer list
  const body = el("div", "flex:1 1 auto;display:flex;min-height:0;");
  const stageBox = el("div", "flex:1 1 auto;position:relative;background:#151515;min-width:0;");
  const stage = el("canvas", "position:absolute;inset:0;width:100%;height:100%;touch-action:none;");
  stageBox.appendChild(stage);
  const side = el("div", "width:260px;flex:0 0 260px;display:flex;flex-direction:column;border-left:1px solid #444;min-height:0;");
  const sideBar = el("div", "display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid #333;flex-wrap:wrap;");
  sideBar.append(
    button("＋ Add images", "Pick images from the library (the gallery stays open)", () => addImages(), "background:#2a6db0;"),
    el("span", "color:#888;font-size:11px;align-self:center;", "top = front"),
  );
  const list = el("div", "flex:1 1 auto;overflow:auto;padding:4px 0;");
  const hint = el("div", "padding:6px 8px;color:#888;font-size:11px;line-height:1.4;border-top:1px solid #333;",
    "Drag to move · corner handles scale (aspect kept) · ✂ crops with the edge handles · Del removes");
  side.append(sideBar, list, hint);
  body.append(stageBox, side);
  panel.append(bar, body);

  // ---- state
  let entries = [];   // loaded images, parallel to data.layers
  let bgEntry = null;
  let selected = -1;
  let cropMode = false;
  let drag = null;
  let view = { k: 1, ox: 0, oy: 0 };

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    ro.disconnect();
  }
  // Escape does not close the composer (work would be lost); Cancel / Done do
  const onKey = (e) => {
    if (!isTopOverlay(overlay) || e.target instanceof HTMLInputElement) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) { e.preventDefault(); e.stopPropagation(); removeLayer(selected); }
  };
  document.addEventListener("keydown", onKey, true);

  async function loadEntries() {
    entries = await Promise.all(data.layers.map((l) => loadLayerImage(l.path).catch(() => null)));
    bgEntry = data.background.image ? await loadLayerImage(data.background.image).catch(() => null) : null;
  }

  function syncInputs() {
    presetSel.value = data.canvas.preset || "custom";
    wIn.value = Math.round(data.canvas.w);
    hIn.value = Math.round(data.canvas.h);
    const custom = presetSel.value === "custom";
    wIn.disabled = hIn.disabled = !custom;
    bgName.textContent = data.background.image ? baseOf(data.background.image) : "";
    bBgClear.style.display = data.background.image ? "" : "none";
    sizeInfo.textContent = `${data.layers.length} image(s) · output ${Math.round(data.canvas.w)}×${Math.round(data.canvas.h)}`;
  }

  function changed() {
    if (data.canvas.preset === "fit") fitCanvas(data);
    syncInputs();
    renderList();
    draw();
  }

  // ---- toolbar actions
  presetSel.addEventListener("change", () => {
    const p = presetSel.value;
    data.canvas.preset = p;
    if (PRESETS[p]) refitLayers(data, ...presetSize(PRESETS[p]));
    changed();
  });
  const onSize = () => {
    const [w, h] = limitCanvas(Math.max(16, Number(wIn.value) || 16), Math.max(16, Number(hIn.value) || 16));
    refitLayers(data, w, h);
    changed();
  };
  wIn.addEventListener("change", onSize);
  hIn.addEventListener("change", onSize);
  spIn.addEventListener("change", () => {
    data.spacing = Math.max(0, Number(spIn.value) || 0);
    if (data.arrange) doArrange(data.arrange); else changed();
  });
  colorIn.addEventListener("input", () => { data.background.color = colorIn.value; draw(); });

  function doArrange(mode) {
    if (!data.layers.length) { notify("Add images first."); return; }
    if (entries.some((e) => !e)) { notify("Some images could not be loaded."); return; }
    arrange(data, entries, mode);
    syncInputs();
    draw();
  }

  async function addImages() {
    await openGallery({
      startDir,
      keepOpen: true,
      onPick: async (path) => {
        try {
          const entry = await loadLayerImage(path);
          const [nw, nh] = natural(entry);
          // new layers start at a third of the canvas, centered
          const s = Math.min(data.canvas.w / 3 / nw, data.canvas.h / 3 / nh);
          data.layers.push({ path, x: (data.canvas.w - nw * s) / 2, y: (data.canvas.h - nh * s) / 2, w: nw * s, h: nh * s, crop: [0, 0, 1, 1] });
          entries.push(entry);
          selected = data.layers.length - 1;
          if (data.arrange) arrange(data, entries, data.arrange);
          changed();
        } catch (e) { notify(e.message); }
      },
    });
  }

  async function pickBackground() {
    await openGallery({
      startDir,
      onPick: async (path) => {
        data.background.image = path;
        bgEntry = await loadLayerImage(path).catch(() => null);
        changed();
      },
    });
  }

  function removeLayer(i) {
    data.layers.splice(i, 1);
    entries.splice(i, 1);
    selected = -1;
    cropMode = false;
    changed();
  }

  function moveLayer(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= data.layers.length) return;
    [data.layers[i], data.layers[j]] = [data.layers[j], data.layers[i]];
    [entries[i], entries[j]] = [entries[j], entries[i]];
    if (selected === i) selected = j;
    renderList();
    draw();
  }

  // ---- layer list (front first)
  function renderList() {
    list.textContent = "";
    if (!data.layers.length) {
      list.appendChild(el("div", "padding:12px;color:#888;", "No images yet – use ＋ Add images."));
      return;
    }
    for (let i = data.layers.length - 1; i >= 0; i--) {
      const l = data.layers[i];
      const active = i === selected;
      const row = el("div",
        `display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;${active ? "background:#2a6db0;color:#fff;" : ""}`);
      const thumb = el("img", "width:36px;height:36px;object-fit:contain;background:#111;border-radius:3px;flex:0 0 36px;");
      thumb.src = libUrl("/thumb", { path: l.path });
      const name = el("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;", baseOf(l.path));
      name.title = l.path;
      const small = "padding:0 5px;";
      const cropBtn = button("✂", "Crop with the edge handles", () => { selected = i; cropMode = !(cropMode && active); renderList(); draw(); },
        small + (active && cropMode ? "background:#b07a2a;" : ""));
      row.append(thumb, name,
        button("↑", "Bring forward", () => moveLayer(i, 1), small),
        button("↓", "Send backward", () => moveLayer(i, -1), small),
        cropBtn,
        button("×", "Remove from the composition", () => removeLayer(i), small));
      row.addEventListener("click", () => { selected = i; if (!active) cropMode = false; renderList(); draw(); });
      list.appendChild(row);
    }
  }

  // ---- drawing
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = stage.clientWidth, ch = stage.clientHeight;
    if (!cw || !ch) return;
    if (stage.width !== Math.round(cw * dpr) || stage.height !== Math.round(ch * dpr)) {
      stage.width = Math.round(cw * dpr);
      stage.height = Math.round(ch * dpr);
    }
    const ctx = stage.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const pad = 24;
    const k = Math.min((cw - 2 * pad) / data.canvas.w, (ch - 2 * pad) / data.canvas.h);
    view = { k, ox: (cw - data.canvas.w * k) / 2, oy: (ch - data.canvas.h * k) / 2 };
    // checkerboard-ish frame so the canvas edge is visible
    ctx.fillStyle = "#000";
    ctx.fillRect(view.ox - 1, view.oy - 1, data.canvas.w * k + 2, data.canvas.h * k + 2);
    drawComposition(ctx, data, k, view.ox, view.oy, entries, bgEntry);

    const l = data.layers[selected];
    if (!l) return;
    const r = screenRect(l);
    if (cropMode && entries[selected]) {
      // the whole image, dimmed, so you see what the crop leaves out
      const [nw, nh] = natural(entries[selected]);
      const fw = r.w / l.crop[2], fh = r.h / l.crop[3];
      const fx = r.x - l.crop[0] * fw, fy = r.y - l.crop[1] * fh;
      ctx.globalAlpha = 0.3;
      ctx.drawImage(entries[selected].img, 0, 0, nw, nh, fx, fy, fw, fh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#888";
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(fx, fy, fw, fh);
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = cropMode ? "#fa4" : "#4af";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = cropMode ? "#fa4" : "#4af";
    for (const [, hx, hy] of handles(r)) ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
    const px = `${Math.round(l.w)}×${Math.round(l.h)}`;
    ctx.font = "11px sans-serif";
    const tw = ctx.measureText(px).width;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(r.x + 3, r.y + 3, tw + 6, 15);
    ctx.fillStyle = "#fff";
    ctx.fillText(px, r.x + 6, r.y + 14);
  }

  const screenRect = (l) => ({ x: view.ox + l.x * view.k, y: view.oy + l.y * view.k, w: l.w * view.k, h: l.h * view.k });
  // scale: the four corners; crop: corners and edge midpoints
  function handles(r) {
    const h = [["nw", r.x, r.y], ["ne", r.x + r.w, r.y], ["se", r.x + r.w, r.y + r.h], ["sw", r.x, r.y + r.h]];
    if (cropMode) {
      h.push(["n", r.x + r.w / 2, r.y], ["e", r.x + r.w, r.y + r.h / 2], ["s", r.x + r.w / 2, r.y + r.h], ["w", r.x, r.y + r.h / 2]);
    }
    return h;
  }

  const pointer = (e) => {
    const b = stage.getBoundingClientRect();
    const sx = (e.clientX - b.left) * (stage.clientWidth / b.width), sy = (e.clientY - b.top) * (stage.clientHeight / b.height);
    return { sx, sy, x: (sx - view.ox) / view.k, y: (sy - view.oy) / view.k };
  };

  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = pointer(e);
    const sel = data.layers[selected];
    if (sel) {
      const hit = handles(screenRect(sel)).find(([, hx, hy]) => Math.abs(p.sx - hx) <= HANDLE && Math.abs(p.sy - hy) <= HANDLE);
      if (hit) {
        drag = { type: hit[0], start: p, layer: { ...sel, crop: [...sel.crop] } };
        stage.setPointerCapture(e.pointerId);
        return;
      }
    }
    // topmost layer under the pointer
    let idx = -1;
    for (let i = data.layers.length - 1; i >= 0; i--) {
      const l = data.layers[i];
      if (p.x >= l.x && p.x <= l.x + l.w && p.y >= l.y && p.y <= l.y + l.h) { idx = i; break; }
    }
    if (idx !== selected) cropMode = false;
    selected = idx;
    if (idx >= 0) {
      drag = { type: "move", start: p, layer: { ...data.layers[idx] } };
      stage.setPointerCapture(e.pointerId);
    }
    renderList();
    draw();
  });

  stage.addEventListener("pointermove", (e) => {
    const p = pointer(e);
    if (!drag) {
      const sel = data.layers[selected];
      const hit = sel && handles(screenRect(sel)).find(([, hx, hy]) => Math.abs(p.sx - hx) <= HANDLE && Math.abs(p.sy - hy) <= HANDLE);
      const cursors = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
      stage.style.cursor = hit ? cursors[hit[0]] : "default";
      return;
    }
    const l = data.layers[selected];
    const o = drag.layer;
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (drag.type === "move") {
      l.x = o.x + dx;
      l.y = o.y + dy;
    } else if (cropMode) {
      cropDrag(l, o, drag.type, dx, dy);
    } else {
      // scale from the opposite corner, aspect kept
      const t = drag.type;
      const sx = t.includes("e") ? 1 : -1, sy = t.includes("s") ? 1 : -1;
      const f = Math.max((o.w + sx * dx) / o.w, (o.h + sy * dy) / o.h, 8 / Math.min(o.w, o.h));
      l.w = o.w * f;
      l.h = o.h * f;
      l.x = sx > 0 ? o.x : o.x + o.w - l.w;
      l.y = sy > 0 ? o.y : o.y + o.h - l.h;
    }
    draw();
  });

  // moves crop edges; the visible image keeps its scale and place
  function cropDrag(l, o, type, dx, dy) {
    const fw = o.w / o.crop[2], fh = o.h / o.crop[3]; // full image size on the canvas
    let [cx, cy, cw, ch] = o.crop;
    let x0 = cx, y0 = cy, x1 = cx + cw, y1 = cy + ch;
    const min = 0.02;
    if (type.includes("w")) x0 = Math.min(Math.max(0, cx + dx / fw), x1 - min);
    if (type.includes("e")) x1 = Math.max(Math.min(1, cx + cw + dx / fw), x0 + min);
    if (type.includes("n")) y0 = Math.min(Math.max(0, cy + dy / fh), y1 - min);
    if (type.includes("s")) y1 = Math.max(Math.min(1, cy + ch + dy / fh), y0 + min);
    l.crop = [x0, y0, x1 - x0, y1 - y0];
    l.x = o.x + (x0 - cx) * fw;
    l.y = o.y + (y0 - cy) * fh;
    l.w = (x1 - x0) * fw;
    l.h = (y1 - y0) * fh;
  }

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    data.arrange = null; // hand-placed now
    changed();
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("dblclick", () => { if (selected >= 0) { cropMode = !cropMode; renderList(); draw(); } });

  const ro = new ResizeObserver(() => draw());
  ro.observe(stageBox);

  syncInputs();
  renderList();
  await loadEntries();
  if (data.layers.some((l, i) => !entries[i])) notify("Some images of this composition are missing in the library.");
  draw();
}
