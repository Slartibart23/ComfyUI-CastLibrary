// Cast Library: server calls, gallery window with folder / image management and
// small dialogs (shared by the node).

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

export const PREFIX = "/cast_library";
const DRAG_TYPE = "application/x-cast-library";

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
export const folderLabel = (dir) => dir || "Cast Library";

export const isImageFile = (f) =>
  /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i.test(f.name || "");

export const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
const hasItems = (e) => [...(e.dataTransfer?.types || [])].includes(DRAG_TYPE);

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

// all folders in display order: [{ path, name, count, depth, total }]
export function flattenTree(tree) {
  const out = [];
  const walk = (f, depth) => {
    const row = { path: f.path, name: f.name, count: f.count, depth, total: f.count };
    out.push(row);
    for (const c of f.children) row.total += walk(c, depth + 1);
    return row.total;
  };
  if (tree?.tree) walk(tree.tree, 0);
  return out;
}

// Nodes keep library paths in their widgets; after moving or renaming they are
// told how paths changed. remap(path) returns the new path or null.
const moveListeners = new Set();
export const onPathsMoved = (fn) => { moveListeners.add(fn); return () => moveListeners.delete(fn); };
function pathsMoved(remap) {
  moveListeners.forEach((fn) => { try { fn(remap); } catch {} });
}
const prefixRemap = (from, to) => (p) =>
  p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : null;

// ---------------------------------------------------------------- actions
export async function uploadFiles(dir, files) {
  const images = [...files].filter(isImageFile);
  if (!images.length) throw new Error("No image files to upload.");
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

async function moveImages(paths, target) {
  const { moved } = await postJSON("/images/move", { paths, target });
  pathsMoved((p) => moved[p] ?? null);
  await getTree(true);
  return Object.keys(moved).length;
}

async function moveFolder(path, target) {
  const res = await postJSON("/folder/move", { path, target });
  pathsMoved(prefixRemap(path, res.path));
  await getTree(true);
  return res.path;
}

// ---------------------------------------------------------------- dialogs
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

// small dialog; body(panel) adds the content, ok() may throw to show an error
function dialog({ title, okLabel, danger, body, ok, focus }) {
  return new Promise((resolve) => {
    const { overlay, panel } = modal("width:400px;max-width:92vw;padding:16px;display:flex;flex-direction:column;gap:10px;");
    overlay.dataset.castDialog = "1";
    panel.appendChild(el("div", "font-weight:bold;font-size:14px;", title));
    body?.(panel);
    const err = el("div", "color:#f77;font-size:12px;min-height:14px;");
    const row = el("div", "display:flex;justify-content:flex-end;gap:8px;");
    const close = (v) => { overlay.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const run = async () => {
      err.textContent = "";
      try { close(await ok()); } catch (e) { err.textContent = e.message; }
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(null); }
      if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); run(); }
    };
    document.addEventListener("keydown", onKey, true);
    row.append(button("Cancel", "", () => close(null)), button(okLabel, "", run, danger ? "background:#a33;" : "background:#2a6db0;"));
    panel.append(err, row);
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(null); });
    setTimeout(() => focus?.focus(), 0);
  });
}

function textDialog(title, value, okLabel, action) {
  const input = el("input", "padding:5px;background:#111;color:#eee;border:1px solid #555;border-radius:4px;");
  input.value = value || "";
  return dialog({
    title, okLabel, focus: input,
    body: (p) => { p.appendChild(input); setTimeout(() => input.select(), 0); },
    ok: () => action(input.value),
  });
}

const confirmDialog = (title, text, okLabel) =>
  dialog({ title, okLabel, danger: true, body: (p) => p.appendChild(el("div", "color:#ccc;line-height:1.4;", text)), ok: () => true });

// choose a target folder; folders in `exclude` (and below) are not offered
function folderDialog(tree, title, exclude) {
  let chosen = null;
  return dialog({
    title, okLabel: "Move here",
    body: (p) => {
      const list = el("div", "max-height:50vh;overflow:auto;border:1px solid #444;border-radius:4px;padding:4px 0;");
      for (const f of flattenTree(tree)) {
        if (exclude && (f.path === exclude || f.path.startsWith(exclude + "/"))) continue;
        const item = el("div", `padding:3px 10px 3px ${10 + f.depth * 14}px;cursor:pointer;white-space:nowrap;`,
          `${f.depth ? "" : "🏠 "}${f.name}  (${f.count})`);
        item.addEventListener("click", () => {
          chosen = f.path;
          list.querySelectorAll("div").forEach((d) => { d.style.background = ""; });
          item.style.background = "#2a6db0";
        });
        list.appendChild(item);
      }
      p.appendChild(list);
    },
    ok: () => {
      if (chosen == null) throw new Error("Choose a folder.");
      return chosen;
    },
  });
}

// "New folder" inside `parent`; resolves with the new folder path or null
export function newFolderDialog(parent) {
  return textDialog(`New folder in ${folderLabel(parent)}`, "", "Create", async (name) => {
    const { path } = await postJSON("/folder/create", { parent, name });
    await getTree(true);
    return path;
  });
}

// ---------------------------------------------------------------- gallery
function loadPref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`CastLibrary.${key}`)) ?? fallback; } catch { return fallback; }
}
function storePref(key, value) {
  try { localStorage.setItem(`CastLibrary.${key}`, JSON.stringify(value)); } catch {}
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
  Object.assign(size, { type: "range", min: 80, max: 320, value: loadPref("thumbSize", 150), title: "Thumbnail size" });
  const bUpload = button("⬆ Upload", "Add images to the shown folder (or drop them here)", async () => doUpload(await pickFiles()));
  const bExplorer = button("📂 Explorer", "Open the shown folder in Explorer", () => openInExplorer(dir));
  const bRefresh = button("⟳", "Reload", () => refresh());
  const bClose = button("✕", "Close (Esc)", () => close());
  header.append(title, pathLabel, el("span", "color:#888;font-size:11px;", "Size"), size, bUpload, bExplorer, bRefresh, bClose);

  // body: folder tree | images
  const body = el("div", "flex:1 1 auto;display:flex;min-height:0;");
  const sideWrap = el("div", "width:250px;flex:0 0 250px;display:flex;flex-direction:column;border-right:1px solid #444;min-height:0;");
  const folderBar = el("div", "display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px;border-bottom:1px solid #333;");
  const bNewFolder = button("＋ Folder", "New folder inside the shown folder", async () => {
    const path = await newFolderDialog(dir);
    if (path) { collapsed.delete(dir); await show(path); }
  });
  const bRename = button("Rename", "Rename the shown folder", async () => {
    const res = await textDialog(`Rename "${baseOf(dir)}"`, baseOf(dir), "Rename", async (name) => {
      const r = await postJSON("/folder/rename", { path: dir, name });
      pathsMoved(prefixRemap(dir, r.path));
      await getTree(true);
      return r.path;
    });
    if (res) await show(res);
  });
  const bMoveFolder = button("Move", "Move the shown folder into another folder (or drag it in the tree)", async () => {
    const target = await folderDialog(tree, `Move "${baseOf(dir)}" to…`, dir);
    if (target == null) return;
    try { await show(await moveFolder(dir, target)); } catch (e) { notify(e.message); }
  });
  const bDeleteFolder = button("Delete", "Move the shown folder with everything in it to the recycle bin", async () => {
    const f = flattenTree(tree).find((x) => x.path === dir);
    const ok = await confirmDialog(`Delete "${baseOf(dir)}"?`,
      `The folder, its sub folders and ${f?.total ?? 0} image(s) go to the recycle bin.`, "Delete");
    if (!ok) return;
    try {
      await postJSON("/folder/delete", { path: dir });
      await getTree(true);
      await show(dirOf(dir));
    } catch (e) { notify(e.message); }
  });
  folderBar.append(bNewFolder, bRename, bMoveFolder, bDeleteFolder);
  const side = el("div", "flex:1 1 auto;overflow:auto;padding:4px 0;");
  sideWrap.append(folderBar, side);

  const mainWrap = el("div", "flex:1 1 auto;display:flex;flex-direction:column;min-width:0;");
  const selBar = el("div", "display:none;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid #333;background:#1d2a38;");
  const selCount = el("span", "font-weight:bold;");
  selBar.append(
    selCount,
    button("Move to…", "Move the selected images (or drag them onto a folder)", async () => {
      if (!selected.size) return;
      const target = await folderDialog(tree, `Move ${selected.size} image(s) to…`);
      if (target == null) return;
      try {
        const n = await moveImages([...selected], target);
        notify(`${n} image(s) moved to ${folderLabel(target)}`, "success");
        selected.clear();
        await show(dir);
      } catch (e) { notify(e.message); }
    }),
    button("Delete", "Move the selected images to the recycle bin", async () => {
      if (!selected.size) return;
      const ok = await confirmDialog(`Delete ${selected.size} image(s)?`,
        "They go to the recycle bin, together with their mask, colour and shape files.", "Delete");
      if (!ok) return;
      try {
        await postJSON("/images/delete", { paths: [...selected] });
        selected.clear();
        await getTree(true);
        await show(dir);
      } catch (e) { notify(e.message); }
    }),
    button("Select all", "", () => { images.forEach((i) => selected.add(i.path)); renderGrid(); }),
    button("Clear", "Clear the selection", () => { selected.clear(); renderGrid(); }),
    el("span", "color:#9ab;font-size:11px;", "Ctrl/Shift-click selects · drag onto a folder to move"),
  );
  const main = el("div", "flex:1 1 auto;overflow:auto;position:relative;padding:10px;");
  const grid = el("div", "display:grid;gap:10px;align-content:start;");
  const dropHint = el("div",
    "position:absolute;inset:6px;border:2px dashed #4af;border-radius:8px;background:rgba(40,110,180,0.15);" +
    "display:none;align-items:center;justify-content:center;font-size:16px;color:#cde;pointer-events:none;");
  main.append(grid, dropHint);
  mainWrap.append(selBar, main);
  body.append(sideWrap, mainWrap);
  panel.append(header, body);

  let tree = null;
  let dir = startDir || "";
  let images = [];
  let token = 0;
  let lastClicked = null;
  const selected = new Set();
  const collapsed = new Set(loadPref("collapsed", []));

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  }
  const onKey = (e) => {
    if (e.key === "Escape" && !document.querySelector("[data-cast-dialog]")) {
      e.preventDefault(); e.stopPropagation(); close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });

  size.addEventListener("input", () => { storePref("thumbSize", Number(size.value)); applySize(); });
  const applySize = () => { grid.style.gridTemplateColumns = `repeat(auto-fill,minmax(${size.value}px,1fr))`; };
  applySize();

  // ---- drag & drop between gallery parts
  const setDrag = (e, payload) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
  };
  const readDrag = (e) => { try { return JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch { return null; } };

  async function dropOnFolder(e, target) {
    if (hasFiles(e)) {
      await doUpload(e.dataTransfer.files, target);
      return;
    }
    const item = readDrag(e);
    if (!item) return;
    try {
      if (item.kind === "images") {
        const n = await moveImages(item.paths, target);
        notify(`${n} image(s) moved to ${folderLabel(target)}`, "success");
        item.paths.forEach((p) => selected.delete(p));
        await show(dir);
      } else if (item.kind === "folder") {
        const moved = await moveFolder(item.path, target);
        await show(dir === item.path || dir.startsWith(item.path + "/") ? moved + dir.slice(item.path.length) : dir);
      }
    } catch (err) { notify(err.message); }
  }

  // ---- folder tree
  function renderSide() {
    side.textContent = "";
    const rows = flattenTree(tree);
    const hidden = (p) => [...collapsed].some((c) => p.startsWith(c + "/"));
    for (const f of rows) {
      if (hidden(f.path)) continue;
      const active = f.path === dir;
      const hasKids = rows.some((r) => r.path.startsWith(f.path ? f.path + "/" : "") && r.depth === f.depth + 1);
      const row = el("div",
        `display:flex;align-items:center;gap:2px;padding:3px 8px 3px ${4 + f.depth * 14}px;cursor:pointer;white-space:nowrap;` +
        `${active ? "background:#2a6db0;color:#fff;" : ""}${f.depth ? "" : "font-weight:bold;"}`);
      const tw = el("span", "width:14px;flex:0 0 14px;text-align:center;color:#999;", hasKids && f.depth ? (collapsed.has(f.path) ? "▸" : "▾") : "");
      tw.addEventListener("click", (e) => {
        if (!hasKids || !f.depth) return;
        e.stopPropagation();
        collapsed.has(f.path) ? collapsed.delete(f.path) : collapsed.add(f.path);
        storePref("collapsed", [...collapsed]);
        renderSide();
      });
      const name = el("span", "overflow:hidden;text-overflow:ellipsis;", `${f.depth ? "" : "🏠 "}${f.name}`);
      const count = el("span", "color:#999;font-size:11px;margin-left:4px;", f.count ? `${f.count}` : "");
      row.append(tw, name, count);
      row.title = f.path || "Library root";
      row.addEventListener("click", () => show(f.path));
      if (f.depth) {
        row.draggable = true;
        row.addEventListener("dragstart", (e) => setDrag(e, { kind: "folder", path: f.path }));
      }
      row.addEventListener("dragover", (e) => {
        if (!hasFiles(e) && !hasItems(e)) return;
        e.preventDefault();
        row.style.outline = "2px solid #4af";
      });
      row.addEventListener("dragleave", () => { row.style.outline = ""; });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.style.outline = "";
        dropOnFolder(e, f.path);
      });
      row.addEventListener("mouseenter", () => { if (!active) row.style.background = "#333"; });
      row.addEventListener("mouseleave", () => { if (!active) row.style.background = ""; });
      side.appendChild(row);
    }
  }

  // ---- images
  function card(img) {
    const active = img.path === current;
    const isSel = selected.has(img.path);
    const border = isSel ? "#fa4" : active ? "#4af" : "transparent";
    const c = el("div",
      `cursor:pointer;border-radius:6px;overflow:hidden;background:#111;border:2px solid ${border};display:flex;flex-direction:column;`);
    if (active) c.dataset.active = "1";
    const box = el("div", "position:relative;aspect-ratio:1/1;overflow:hidden;background:#181818;");
    const im = el("img", "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;");
    im.loading = "lazy";
    im.decoding = "async";
    im.src = libUrl("/thumb", { path: img.path, v: img.v, p: img.paint || 0 });
    im.draggable = false;
    box.appendChild(im);
    const check = el("div",
      `position:absolute;top:4px;left:4px;width:18px;height:18px;border-radius:4px;border:2px solid #fff;` +
      `background:${isSel ? "#fa4" : "rgba(0,0,0,0.4)"};color:#000;font:bold 12px/16px sans-serif;text-align:center;` +
      `display:${isSel || selected.size ? "block" : "none"};`, isSel ? "✓" : "");
    check.title = "Select";
    check.addEventListener("click", (e) => { e.stopPropagation(); toggle(img, e); });
    box.appendChild(check);
    const badges = el("div", "position:absolute;top:4px;right:4px;display:flex;gap:3px;");
    const badge = (t, tip, bg) => { const b = el("span", `font:bold 10px sans-serif;padding:1px 4px;border-radius:3px;background:${bg};color:#fff;`, t); b.title = tip; return b; };
    if (img.mask) badges.appendChild(badge("M", "Has a MaskEditor mask", "#b04a2a"));
    if (img.paint) badges.appendChild(badge("P", "Has colour painted in the MaskEditor", "#8a3ab0"));
    if (img.shape) badges.appendChild(badge("S", "Has a rectangle / freehand shape", "#2a7db0"));
    box.appendChild(badges);
    const cap = el("div", "padding:3px 6px;font-size:11px;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", img.name);
    cap.title = img.name;
    c.append(box, cap);
    c.draggable = true;
    c.addEventListener("dragstart", (e) => {
      const paths = selected.has(img.path) ? [...selected] : [img.path];
      setDrag(e, { kind: "images", paths });
    });
    c.addEventListener("mouseenter", () => { check.style.display = "block"; if (!isSel && !active) c.style.borderColor = "#666"; });
    c.addEventListener("mouseleave", () => { check.style.display = isSel || selected.size ? "block" : "none"; if (!isSel && !active) c.style.borderColor = "transparent"; });
    c.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || selected.size) { toggle(img, e); return; }
      close();
      onPick?.(img.path);
    });
    return c;
  }

  function toggle(img, e) {
    if (e.shiftKey && lastClicked) {
      const a = images.findIndex((i) => i.path === lastClicked), b = images.findIndex((i) => i.path === img.path);
      if (a >= 0 && b >= 0) for (const i of images.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(i.path);
    } else if (selected.has(img.path)) {
      selected.delete(img.path);
    } else {
      selected.add(img.path);
    }
    lastClicked = img.path;
    renderGrid();
  }

  function renderGrid() {
    grid.textContent = "";
    for (const p of [...selected]) if (!images.some((i) => i.path === p)) selected.delete(p);
    selBar.style.display = selected.size ? "flex" : "none";
    selCount.textContent = `${selected.size} selected`;
    if (!images.length) {
      grid.appendChild(el("div", "color:#888;padding:20px;grid-column:1/-1;", "No images here – drop images here or use ⬆ Upload."));
    }
    for (const img of images) grid.appendChild(card(img));
  }

  async function show(newDir) {
    tree = await getTree();
    const all = flattenTree(tree);
    if (!all.some((f) => f.path === newDir)) newDir = all.find((f) => f.depth === 1)?.path ?? "";
    if (newDir !== dir) { selected.clear(); lastClicked = null; }
    dir = newDir;
    // keep the shown folder visible in the tree
    for (const c of [...collapsed]) if (dir.startsWith(c + "/")) collapsed.delete(c);
    onDirChange?.(dir);
    renderSide();
    pathLabel.textContent = folderLabel(dir).replaceAll("/", " › ");
    for (const b of [bRename, bMoveFolder, bDeleteFolder]) b.disabled = !dir;
    const my = ++token;
    try {
      const res = await getJSON("/images", { dir });
      if (my !== token) return;
      images = res.images;
      renderGrid();
      grid.querySelector("[data-active]")?.scrollIntoView({ block: "center" });
    } catch (e) {
      images = [];
      grid.textContent = "";
      grid.appendChild(el("div", "color:#f77;padding:20px;", e.message));
    }
  }

  async function refresh() {
    await getTree(true);
    await show(dir);
  }

  async function doUpload(files, target = dir) {
    if (!files?.length) return;
    try {
      const paths = await uploadFiles(target, files);
      notify(`${paths.length} image(s) added to ${folderLabel(target)}`, "success");
      await refresh();
    } catch (e) {
      notify(e.message);
    }
  }

  // files from the desktop dropped on the image area
  let dragDepth = 0;
  main.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropHint.style.display = "flex";
    dropHint.textContent = `Drop to add to ${folderLabel(dir)}`;
  });
  main.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  main.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropHint.style.display = "none"; } });
  main.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    dropHint.style.display = "none";
    doUpload(e.dataTransfer.files);
  });

  await refresh();
}
