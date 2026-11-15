// Cast Library: server calls, gallery window and small dialogs (shared by the node).

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

export const PREFIX = "/cast_library";

// ------------------------------------------------------------------ helpers
export function el(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}

export function notify(detail, severity = "error") {
  try {
    app.extensionManager.toast.add({ severity, summary: "Cast Library", detail, life: severity === "error" ? 7000 : 2500 });
  } catch {
    if (severity === "error") alert(`Cast Library: ${detail}`);
  }
}

async function request(path, opts = {}) {
  const res = await api.fetchApi(PREFIX + path, { cache: "no-store", ...opts });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const getJSON = (path, params) => request(params ? `${path}?${new URLSearchParams(params)}` : path);
export const postJSON = (path, body) =>
  request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const libUrl = (path, params) => api.apiURL(`${PREFIX}${path}?${new URLSearchParams(params)}`);

export const dirOf = (rel) => (rel && rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
export const baseOf = (rel) => (rel ? rel.slice(rel.lastIndexOf("/") + 1) : "");

export const isImageFile = (f) =>
  /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i.test(f.name || "");

export const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

const stop = (e) => e.stopPropagation();

export function button(label, title, onClick, extraCss = "") {
  const b = el("button", BTN_CSS + extraCss, label);
  b.title = title;
  b.addEventListener("pointerdown", stop);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return b;
}
export const BTN_CSS =
  "padding:2px 8px;border:1px solid #555;border-radius:4px;background:#333;color:#ddd;cursor:pointer;font:12px sans-serif;white-space:nowrap;";

// ---------------------------------------------------------------- tree cache
let treeCache = null;
let treePromise = null;
const treeListeners = new Set();

export async function getTree(force = false) {
  if (treeCache && !force) return treeCache;
  if (!treePromise) {
    treePromise = getJSON("/tree")
      .then((t) => { treeCache = t; treeListeners.forEach((fn) => { try { fn(t); } catch {} }); return t; })
      .finally(() => { treePromise = null; });
  }
  return treePromise;
}
export const onTreeChange = (fn) => { treeListeners.add(fn); return () => treeListeners.delete(fn); };

// library / area that contain a folder path
export function findDir(tree, dir) {
  for (const lib of tree?.libraries || []) {
    for (const area of lib.areas) if (area.path === dir) return { lib, area };
  }
  for (const lib of tree?.libraries || []) {
    if (dir === lib.path || dir.startsWith(lib.path + "/")) return { lib, area: lib.areas[0] || null };
  }
  return null;
}

export const areaLabel = (area) => `${area.name || "(main folder)"}  (${area.count})`;

// ---------------------------------------------------------------- actions
export async function uploadFiles(dir, files) {
  const images = [...files].filter(isImageFile);
  if (!images.length) throw new Error("No image files to upload.");
  if (!dir) throw new Error("Choose a library and area first.");
  const fd = new FormData();
  fd.append("dir", dir);
  for (const f of images) fd.append("image", f, f.name);
  const res = await api.fetchApi(`${PREFIX}/upload`, { method: "POST", body: fd });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  getTree(true);
  return data.paths || [];
}

export function pickFiles() {
  return new Promise((resolve) => {
    const input = el("input");
    Object.assign(input, { type: "file", multiple: true, accept: "image/*,.tif,.tiff" });
    input.style.display = "none";
    input.addEventListener("change", () => { resolve([...input.files]); input.remove(); });
    input.addEventListener("cancel", () => { resolve([]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export async function openInExplorer(path) {
  try {
    await postJSON("/explorer", { path });
  } catch (e) {
    notify(e.message);
  }
}

// ---------------------------------------------------------------- modal base
function modal(width) {
  const overlay = el("div",
    "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;");
  const panel = el("div",
    `background:var(--comfy-menu-bg,#222);color:var(--fg-color,#ddd);border:1px solid #444;border-radius:8px;` +
    `box-shadow:0 8px 40px rgba(0,0,0,0.6);font:13px sans-serif;${width}`);
  overlay.appendChild(panel);
  for (const ev of ["pointerdown", "wheel", "keydown", "contextmenu"]) overlay.addEventListener(ev, stop);
  document.body.appendChild(overlay);
  return { overlay, panel };
}

// "New person / library / area" dialog. Resolves with the created folder path or null.
export function newEntryDialog(currentLib) {
  return new Promise((resolve) => {
    const { overlay, panel } = modal("width:380px;padding:16px;display:flex;flex-direction:column;gap:10px;");
    panel.appendChild(el("div", "font-weight:bold;font-size:14px;", "Create in the Cast Library"));
    const kind = el("select", "padding:4px;background:#333;color:#ddd;border:1px solid #555;border-radius:4px;");
    const opts = [["person", "Person (with Face + Body)"], ["library", "Library (e.g. Accessories)"]];
    if (currentLib) opts.push(["area", `Area in "${currentLib.name}"`]);
    for (const [v, t] of opts) kind.appendChild(Object.assign(el("option", null, t), { value: v }));
    const name = el("input", "padding:5px;background:#111;color:#eee;border:1px solid #555;border-radius:4px;");
    name.placeholder = "Name";
    const err = el("div", "color:#f77;font-size:12px;min-height:14px;");
    const row = el("div", "display:flex;justify-content:flex-end;gap:8px;");
    const close = (v) => { overlay.remove(); resolve(v); };
    const ok = async () => {
      err.textContent = "";
      try {
        const body = { kind: kind.value, name: name.value };
        if (kind.value === "area") body.library = currentLib.path;
        const { path } = await postJSON("/create", body);
        await getTree(true);
        close(path);
      } catch (e) {
        err.textContent = e.message;
      }
    };
    row.append(button("Cancel", "", () => close(null)), button("Create", "", ok, "background:#2a6db0;"));
    panel.append(kind, name, err, row);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok();
      if (e.key === "Escape") close(null);
    });
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(null); });
    setTimeout(() => name.focus(), 0);
  });
}

// ---------------------------------------------------------------- gallery
function loadSize() {
  try { return Number(localStorage.getItem("CastLibrary.thumbSize")) || 150; } catch { return 150; }
}
function storeSize(v) {
  try { localStorage.setItem("CastLibrary.thumbSize", String(v)); } catch {}
}

/**
 * Opens the gallery window.
 *   startDir  folder to show first
 *   current   relative path of the image currently used by the node (highlighted)
 *   onPick(path)       an image was chosen (window closes)
 *   onDirChange(dir)   the shown folder changed (node follows it)
 */
export async function openGallery({ startDir, current, onPick, onDirChange }) {
  const { overlay, panel } = modal("width:min(1400px,95vw);height:90vh;display:flex;flex-direction:column;overflow:hidden;");

  // header
  const header = el("div", "display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #444;flex-wrap:wrap;");
  const title = el("div", "font-weight:bold;font-size:14px;", "Cast Library");
  const pathLabel = el("div", "color:#aaa;flex:1 1 auto;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
  const size = el("input", "width:110px;");
  Object.assign(size, { type: "range", min: 80, max: 320, value: loadSize(), title: "Thumbnail size" });
  const bUpload = button("⬆ Upload", "Add images to the shown folder (or drop them here)", async () => doUpload(await pickFiles()));
  const bNew = button("＋ New", "New person, library or area", async () => {
    const path = await newEntryDialog(currentLib());
    if (path) {
      const t = await getTree();
      const hit = findDir(t, path);
      await show(hit?.area?.path ?? path);
    }
  });
  const bExplorer = button("📂 Explorer", "Open the shown folder in Explorer", () => openInExplorer(dir || ""));
  const bRefresh = button("⟳", "Reload", async () => { await getTree(true); await show(dir); });
  const bClose = button("✕", "Close (Esc)", () => close());
  header.append(title, pathLabel, el("span", "color:#888;font-size:11px;", "Size"), size, bUpload, bNew, bExplorer, bRefresh, bClose);

  // body
  const body = el("div", "flex:1 1 auto;display:flex;min-height:0;");
  const side = el("div", "width:230px;flex:0 0 230px;overflow:auto;border-right:1px solid #444;padding:6px 0;");
  const main = el("div", "flex:1 1 auto;overflow:auto;position:relative;padding:10px;");
  const grid = el("div", "display:grid;gap:10px;align-content:start;");
  const dropHint = el("div",
    "position:absolute;inset:6px;border:2px dashed #4af;border-radius:8px;background:rgba(40,110,180,0.15);" +
    "display:none;align-items:center;justify-content:center;font-size:16px;color:#cde;pointer-events:none;");
  main.append(grid, dropHint);
  body.append(side, main);
  panel.append(header, body);

  let tree = null;
  let dir = startDir || "";
  let token = 0;

  const currentLib = () => findDir(tree, dir)?.lib || null;

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  }
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });

  size.addEventListener("input", () => { storeSize(size.value); applySize(); });
  function applySize() {
    grid.style.gridTemplateColumns = `repeat(auto-fill,minmax(${size.value}px,1fr))`;
  }
  applySize();

  function sideItem(text, indent, active, onClick, bold) {
    const item = el("div",
      `padding:3px 10px 3px ${10 + indent}px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
      `${bold ? "font-weight:bold;margin-top:4px;" : ""}${active ? "background:#2a6db0;color:#fff;" : ""}`, text);
    item.title = text;
    if (onClick) {
      item.addEventListener("click", onClick);
      item.addEventListener("mouseenter", () => { if (!active) item.style.background = "#333"; });
      item.addEventListener("mouseleave", () => { if (!active) item.style.background = ""; });
    }
    return item;
  }

  function renderSide() {
    side.textContent = "";
    const groups = [["Persons", "person"], ["Libraries", "library"]];
    for (const [label, kind] of groups) {
      side.appendChild(el("div", "padding:6px 10px 2px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;", label));
      const libs = (tree?.libraries || []).filter((l) => l.kind === kind);
      if (!libs.length) side.appendChild(el("div", "padding:2px 18px;color:#666;font-style:italic;", "none yet – use ＋ New"));
      for (const lib of libs) {
        const single = lib.areas.length === 1 && lib.areas[0].name === "";
        if (single) {
          side.appendChild(sideItem(`${lib.name}  (${lib.areas[0].count})`, 8, dir === lib.areas[0].path, () => show(lib.areas[0].path), true));
          continue;
        }
        side.appendChild(sideItem(lib.name, 8, false, () => show(lib.areas[0]?.path ?? lib.path), true));
        for (const area of lib.areas) side.appendChild(sideItem(areaLabel(area), 22, dir === area.path, () => show(area.path)));
      }
    }
  }

  function card(img) {
    const active = img.path === current;
    const c = el("div",
      `cursor:pointer;border-radius:6px;overflow:hidden;background:#111;border:2px solid ${active ? "#4af" : "transparent"};` +
      "display:flex;flex-direction:column;");
    if (active) c.dataset.active = "1";
    const box = el("div", "position:relative;aspect-ratio:1/1;overflow:hidden;background:#181818;");
    const im = el("img", "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;");
    im.loading = "lazy";
    im.decoding = "async";
    im.src = libUrl("/thumb", { path: img.path, v: img.v });
    im.draggable = false;
    box.appendChild(im);
    const badges = el("div", "position:absolute;top:4px;right:4px;display:flex;gap:3px;");
    const badge = (t, tip, bg) => { const b = el("span", `font:bold 10px sans-serif;padding:1px 4px;border-radius:3px;background:${bg};color:#fff;`, t); b.title = tip; return b; };
    if (img.mask) badges.appendChild(badge("M", "Has a MaskEditor mask", "#b04a2a"));
    if (img.shape) badges.appendChild(badge("S", "Has a rectangle / freehand shape", "#2a7db0"));
    box.appendChild(badges);
    const cap = el("div", "padding:3px 6px;font-size:11px;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", img.name);
    cap.title = img.name;
    c.append(box, cap);
    c.addEventListener("mouseenter", () => { if (!active) c.style.borderColor = "#666"; });
    c.addEventListener("mouseleave", () => { if (!active) c.style.borderColor = "transparent"; });
    c.addEventListener("click", () => { close(); onPick?.(img.path); });
    return c;
  }

  async function show(newDir) {
    tree = await getTree();
    if (newDir == null || !findDir(tree, newDir)) {
      const first = tree.libraries.find((l) => l.areas.length);
      newDir = findDir(tree, newDir || "")?.area?.path ?? first?.areas[0]?.path ?? "";
    }
    dir = newDir;
    onDirChange?.(dir);
    renderSide();
    const hit = findDir(tree, dir);
    pathLabel.textContent = hit ? `${hit.lib.name}${hit.area?.name ? " › " + hit.area.name : ""}` : "";
    bUpload.disabled = !dir;
    grid.textContent = "";
    if (!dir) {
      grid.appendChild(el("div", "color:#888;padding:20px;", "The library is empty. Create a person or a library with ＋ New."));
      return;
    }
    const my = ++token;
    try {
      const { images } = await getJSON("/images", { dir });
      if (my !== token) return;
      if (!images.length) {
        grid.appendChild(el("div", "color:#888;padding:20px;grid-column:1/-1;", "No images yet – drop images here or use ⬆ Upload."));
      }
      for (const img of images) grid.appendChild(card(img));
      grid.querySelector(`[data-active]`)?.scrollIntoView({ block: "center" });
    } catch (e) {
      grid.appendChild(el("div", "color:#f77;padding:20px;", e.message));
    }
  }

  async function doUpload(files) {
    if (!files?.length) return;
    try {
      const paths = await uploadFiles(dir, files);
      notify(`${paths.length} image(s) added`, "success");
      await show(dir);
    } catch (e) {
      notify(e.message);
    }
  }

  // drag & drop upload
  let dragDepth = 0;
  main.addEventListener("dragenter", (e) => { if (!hasFiles(e) || !dir) return; e.preventDefault(); dragDepth++; dropHint.style.display = "flex"; dropHint.textContent = `Drop to add to ${pathLabel.textContent}`; });
  main.addEventListener("dragover", (e) => { if (hasFiles(e) && dir) e.preventDefault(); });
  main.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropHint.style.display = "none"; } });
  main.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    dropHint.style.display = "none";
    doUpload(e.dataTransfer.files);
  });

  await show(dir);
}
