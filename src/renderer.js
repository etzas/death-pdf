import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  './vendor/pdf.worker.min.mjs',
  import.meta.url
).href;

// ============================================================
// State
// ============================================================
const state = {
  pdf: null,
  pdfBytes: null, // original bytes (kept for export)
  pdfPath: null,
  pdfName: null,
  numPages: 0,
  pageDims: [], // {w, h} at scale 1, index by page-1
  scale: 1,
  rotation: 0, // 0 | 90 | 180 | 270, clockwise degrees
  shove: 'none', // 'none' | 'left' | 'right' — pushes the page column to
                 // one side to free up scratch margin on the other
  tool: 'select',
  prevTool: 'select',
  theme: 'none', // PDF viewing theme id (see PDF_THEMES)
  lastDark: 'invert', // remembered dark theme for the quick toggle
  penColor: '#ececec',
  penWidth: 3,
  hlColor: '#f5c518',
  hlWidth: 18,
  eraserWidth: 22,
  annotations: {}, // { [pageNum]: [stroke] }
  undoStack: [],
  redoStack: [],
  dirty: false, // unsaved annotation changes
};

const PEN_PALETTE = ['#ececec', '#c8102e', '#f5c518', '#38bdf8', '#4ade80'];
const HL_PALETTE = ['#f5c518', '#c8102e', '#4ade80', '#38bdf8', '#a78bfa'];
const MAX_UNDO = 80;

// PDF viewing themes. `none` shows the page untouched; the others apply a CSS
// filter to the rendered PDF only (annotations are never inverted). Configured
// in styles.css via #viewer[data-theme='<id>'].
const PDF_THEMES = [
  { id: 'none', label: 'Normal' },
  { id: 'invert', label: 'Escuro (invertido)' },
  { id: 'bw', label: 'Preto e branco' },
  { id: 'sepia', label: 'Sepia escuro' },
  { id: 'night', label: 'Noturno (suave)' },
];

// Interface (app chrome) themes. These swap the palette CSS variables via the
// html[data-ui-theme] attribute (see styles.css). Independent of PDF_THEMES,
// which only filter the rendered document. `death` is the default palette
// baked into :root, so it needs no attribute overrides.
const UI_THEMES = [
  { id: 'death', label: 'Death (vermelho)' },
  { id: 'mono', label: 'Preto e branco' },
  { id: 'light', label: 'Claro' },
];
const DEFAULT_UI_THEME = 'death';

// ============================================================
// Shortcuts
// ============================================================
const DEFAULT_SHORTCUTS = {
  open: 'ctrl+o',
  toolSelect: 'v',
  toolPen: 'p',
  toolHighlighter: 'h',
  toolEraser: 'e',
  toolPan: 'g',
  darkMode: 'ctrl+shift+d',
  undo: 'ctrl+z',
  redo: 'ctrl+shift+z',
  zoomIn: 'ctrl+=',
  zoomOut: 'ctrl+-',
  fitWidth: 'ctrl+0',
  nextPage: 'pagedown',
  prevPage: 'pageup',
  rotateCW: 'ctrl+shift+right',
  rotateCCW: 'ctrl+shift+left',
  shoveLeft: 'alt+left',
  shoveRight: 'alt+right',
  save: 'ctrl+s',
  export: 'ctrl+e',
  fullscreen: 'f11',
  settings: 'ctrl+,',
  clearPage: 'ctrl+shift+backspace',
  closeTab: 'ctrl+w',
  nextTab: 'ctrl+tab',
  prevTab: 'ctrl+shift+tab',
};

const ACTION_LABELS = {
  open: 'Abrir PDF',
  toolSelect: 'Ferramenta: selecionar',
  toolPen: 'Ferramenta: caneta',
  toolHighlighter: 'Ferramenta: marca-texto',
  toolEraser: 'Ferramenta: borracha',
  toolPan: 'Ferramenta: mao (arrastar)',
  darkMode: 'Alternar tema escuro do PDF',
  undo: 'Desfazer',
  redo: 'Refazer',
  zoomIn: 'Aumentar zoom',
  zoomOut: 'Diminuir zoom',
  fitWidth: 'Ajustar a largura',
  nextPage: 'Proxima pagina',
  prevPage: 'Pagina anterior',
  rotateCW: 'Girar 90 (horario)',
  rotateCCW: 'Girar 90 (anti-horario)',
  shoveLeft: 'Empurrar PDF para a esquerda (rascunho)',
  shoveRight: 'Empurrar PDF para a direita (rascunho)',
  save: 'Salvar anotacoes',
  export: 'Exportar PDF anotado',
  fullscreen: 'Tela cheia',
  settings: 'Abrir preferencias',
  clearPage: 'Limpar anotacoes da pagina',
  closeTab: 'Fechar aba',
  nextTab: 'Proxima aba',
  prevTab: 'Aba anterior',
};

let shortcuts = loadShortcuts();

function loadShortcuts() {
  try {
    const saved = JSON.parse(localStorage.getItem('deathpdf.shortcuts') || '{}');
    return { ...DEFAULT_SHORTCUTS, ...saved };
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}
function saveShortcuts() {
  localStorage.setItem('deathpdf.shortcuts', JSON.stringify(shortcuts));
}

// Build a normalized combo string from a KeyboardEvent.
function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  let key = e.key.toLowerCase();
  const map = {
    ' ': 'space',
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
    escape: 'esc',
  };
  key = map[key] || key;
  if (['control', 'meta', 'shift', 'alt'].includes(key)) return null; // lone modifier
  parts.push(key);
  return parts.join('+');
}

function prettyCombo(combo) {
  return combo
    .split('+')
    .map((p) => {
      const m = {
        ctrl: 'Ctrl',
        shift: 'Shift',
        alt: 'Alt',
        space: 'Espaco',
        pageup: 'PageUp',
        pagedown: 'PageDown',
        backspace: 'Backspace',
        esc: 'Esc',
      };
      return m[p] || (p.length === 1 ? p.toUpperCase() : p);
    })
    .join(' + ');
}

// ============================================================
// DOM refs
// ============================================================
const viewer = document.getElementById('viewer');
const pagesEl = document.getElementById('pages');
const emptyState = document.getElementById('empty-state');
const zoomLabel = document.getElementById('zoom-label');
const pageInput = document.getElementById('page-input');
const pageTotal = document.getElementById('page-total');
const toolOptions = document.getElementById('tool-options');
const swatchesEl = document.getElementById('swatches');
const widthSlider = document.getElementById('width-slider');
const widthLabel = document.getElementById('width-label');
const darkBtn = document.getElementById('dark-btn');
const themeMenu = document.getElementById('theme-menu');
const uiThemeBtn = document.getElementById('ui-theme-btn');
const uiThemeMenu = document.getElementById('ui-theme-menu');

// .popover is `position: fixed` (see styles.css) so it's never clipped by
// #toolbar's overflow — position it against the anchor button's actual
// on-screen rect each time it opens.
function positionPopover(popover, anchorBtn) {
  const r = anchorBtn.getBoundingClientRect();
  popover.style.top = r.bottom + 6 + 'px';
  popover.style.right = window.innerWidth - r.right + 'px';
}
const saveBtn = document.getElementById('save-btn');
const shoveLeftBtn = document.getElementById('shove-left-btn');
const shoveRightBtn = document.getElementById('shove-right-btn');
const statusEl = document.getElementById('status');
const tabbarEl = document.getElementById('tabbar');
const tabsEl = document.getElementById('tabs');

// ============================================================
// Tabs
// Each tab holds an independent document: pdf, bytes, annotations,
// undo/redo, zoom/rotation/theme and scroll position. `state` always
// mirrors whichever tab is active; switching tabs snapshots the outgoing
// tab's fields out of `state` and restores the incoming tab's fields into
// it, so the rest of the app keeps reading/writing plain `state.foo`.
// ============================================================
let tabs = [];
let activeTabId = null;
let tabIdSeq = 0;
const TAB_FIELDS = [
  'pdf', 'pdfBytes', 'pdfPath', 'pdfName', 'numPages', 'pageDims',
  'scale', 'rotation', 'shove', 'theme', 'lastDark', 'annotations',
  'undoStack', 'redoStack', 'dirty',
];

function activeTabRecord() {
  return tabs.find((t) => t.id === activeTabId) || null;
}
function snapshotActiveTab() {
  const t = activeTabRecord();
  if (!t) return;
  for (const k of TAB_FIELDS) t[k] = state[k];
  t.scrollTop = viewer.scrollTop;
}
function restoreStateFrom(tab) {
  for (const k of TAB_FIELDS) state[k] = tab[k];
}
function anyDirty() {
  return tabs.some((t) => (t.id === activeTabId ? state.dirty : t.dirty));
}
function updateActiveTabDot() {
  const dot = tabsEl.querySelector('.tab-item.active .tab-dot');
  if (dot) dot.hidden = !state.dirty;
}

function activateTab(tab) {
  activeTabId = tab.id;
  restoreStateFrom(tab);
  viewer.dataset.theme = state.theme;
  darkBtn.classList.toggle('on', state.theme !== 'none');
  renderThemeMenu();
  zoomLabel.textContent = Math.round(state.scale * 100) + '%';
  buildPages();
  updateShoveButtons();
  renderVisible();
  viewer.scrollTop = tab.scrollTop || 0;
  updateCurrentPage();
  updateTitle();
}

function switchTab(id) {
  if (id === activeTabId) return;
  snapshotActiveTab();
  const tab = tabs.find((t) => t.id === id);
  if (tab) activateTab(tab);
  renderTabBar();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const isActive = id === activeTabId;
  const dirty = isActive ? state.dirty : tabs[idx].dirty;
  if (dirty) {
    const name = (isActive ? state.pdfName : tabs[idx].pdfName) || 'documento';
    const ok = window.confirm(
      `Ha anotacoes nao salvas em "${name}". Deseja descarta-las e fechar a aba?`
    );
    if (!ok) return;
  }
  tabs.splice(idx, 1);
  if (isActive) {
    const next = tabs[idx] || tabs[idx - 1] || null;
    if (next) {
      activateTab(next);
    } else {
      activeTabId = null;
      resetToEmpty();
    }
  }
  renderTabBar();
}

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  const next = tabs[(idx + dir + tabs.length) % tabs.length];
  switchTab(next.id);
}

function resetToEmpty() {
  if (io) { io.disconnect(); io = null; }
  pagesEl.innerHTML = '';
  state.pdf = null;
  state.pdfBytes = null;
  state.pdfPath = null;
  state.pdfName = null;
  state.numPages = 0;
  state.pageDims = [];
  state.scale = 1;
  state.rotation = 0;
  state.shove = 'none';
  state.annotations = {};
  state.undoStack = [];
  state.redoStack = [];
  state.dirty = false;
  emptyState.classList.remove('hidden');
  pageTotal.textContent = '/ 0';
  pageInput.value = '0';
  updateTitle();
  positionShoveButtons();
}

function renderTabBar() {
  tabbarEl.hidden = tabs.length === 0;
  tabsEl.innerHTML = '';
  for (const t of tabs) {
    const isActive = t.id === activeTabId;
    const name = (isActive ? state.pdfName : t.pdfName) || 'Sem titulo';
    const dirty = isActive ? state.dirty : t.dirty;

    const item = document.createElement('div');
    item.className = 'tab-item' + (isActive ? ' active' : '');
    item.title = name;

    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    dot.hidden = !dirty;

    const label = document.createElement('span');
    label.className = 'tab-name';
    label.textContent = name;

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = 'Fechar aba';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });

    item.append(dot, label, close);
    item.addEventListener('click', () => switchTab(t.id));
    tabsEl.appendChild(item);
  }
}

// ============================================================
// Rotation coordinate mapping
// Annotations are stored in the PDF's *unrotated* normalized space
// ([0..1], origin top-left). These map to/from the on-screen (rotated)
// canvas whose CSS size is (W, H). rot is clockwise degrees.
// ============================================================
function normToCanvas(nx, ny, W, H, rot) {
  switch (rot) {
    case 90: return [(1 - ny) * W, nx * H];
    case 180: return [(1 - nx) * W, (1 - ny) * H];
    case 270: return [ny * W, (1 - nx) * H];
    default: return [nx * W, ny * H];
  }
}
function canvasToNorm(cx, cy, W, H, rot) {
  switch (rot) {
    case 90: return [cy / H, 1 - cx / W];
    case 180: return [1 - cx / W, 1 - cy / H];
    case 270: return [1 - cy / H, cx / W];
    default: return [cx / W, cy / H];
  }
}
// Displayed page dimensions at scale 1, accounting for rotation.
function dispDim(pageIndex1) {
  const d = state.pageDims[pageIndex1 - 1];
  return state.rotation % 180 === 0 ? { w: d.w, h: d.h } : { w: d.h, h: d.w };
}

// ============================================================
// Toast
// ============================================================
let statusTimer = null;
function toast(msg) {
  statusEl.textContent = msg;
  statusEl.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.hidden = true), 2200);
}

// ============================================================
// PDF loading
// ============================================================
async function openViaDialog() {
  const res = await window.dpdf.openPdf();
  if (!res) return;
  for (const file of res) await loadPdf(file);
}

// Opens `bytes`/`path`/`name` into a brand-new tab and makes it active.
// Each PDF gets its own tab, so an open never discards another tab's work.
// Loads are serialized through a queue: loadPdfImpl mutates the single
// shared `state` object while it awaits, so two overlapping calls (e.g.
// two files opened in quick succession) would otherwise interleave writes
// and corrupt whichever tab's data was mid-load.
let loadQueue = Promise.resolve();
function loadPdf(fileInfo) {
  const run = loadQueue.then(() => loadPdfImpl(fileInfo));
  loadQueue = run;
  return run;
}

async function loadPdfImpl({ bytes, path, name }) {
  const prevActiveId = activeTabId;
  snapshotActiveTab();
  const id = ++tabIdSeq;
  tabs.push({ id });
  activeTabId = id;

  try {
    const u8 = new Uint8Array(bytes);
    state.pdfBytes = u8.slice(); // keep a pristine copy for export
    state.pdfPath = path;
    state.pdfName = name;

    const task = pdfjsLib.getDocument({ data: u8 });
    state.pdf = await task.promise;
    state.numPages = state.pdf.numPages;

    // Gather unscaled dimensions for every page (for placeholder sizing).
    state.pageDims = new Array(state.numPages);
    for (let i = 1; i <= state.numPages; i++) {
      const page = await state.pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      state.pageDims[i - 1] = { w: vp.width, h: vp.height };
    }

    // Load saved annotations, if any.
    state.annotations = {};
    state.undoStack = [];
    state.redoStack = [];
    state.rotation = 0;
    state.shove = 'none';
    state.dirty = false;
    const saved = await window.dpdf.loadAnnotations(path);
    if (saved && saved.annotations) {
      state.annotations = saved.annotations;
      if (typeof saved.rotation === 'number') state.rotation = saved.rotation;
      if (saved.shove === 'left' || saved.shove === 'right') state.shove = saved.shove;
      // Migrate the legacy `darkMode` boolean to the new theme system.
      if (saved.theme) setTheme(saved.theme);
      else if (saved.darkMode === true) setTheme('invert');
    }

    emptyState.classList.add('hidden');
    updateTitle();

    fitWidth(); // sets scale and builds pages
    updateShoveButtons();
    renderTabBar();
    toast(`${name} — ${state.numPages} paginas`);
  } catch (err) {
    console.error(err);
    tabs = tabs.filter((t) => t.id !== id);
    const prevTab = tabs.find((t) => t.id === prevActiveId);
    if (prevTab) {
      activateTab(prevTab);
    } else {
      activeTabId = null;
      resetToEmpty();
    }
    renderTabBar();
    toast('Nao foi possivel abrir o PDF.');
  }
}

// ============================================================
// Layout: build placeholder pages, lazy-render on scroll
// ============================================================
let io = null;

function buildPages() {
  pagesEl.innerHTML = '';
  if (io) io.disconnect();

  for (let i = 1; i <= state.numPages; i++) {
    const dim = dispDim(i);
    const w = dim.w * state.scale;
    const h = dim.h * state.scale;

    const row = document.createElement('div');
    row.className = 'page-row';

    const scratchL = document.createElement('canvas');
    scratchL.className = 'scratch-layer scratch-left';
    const scratchR = document.createElement('canvas');
    scratchR.className = 'scratch-layer scratch-right';

    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.dataset.page = String(i);
    pageEl.dataset.rendered = 'false';
    pageEl.style.width = w + 'px';
    pageEl.style.height = h + 'px';

    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.className = 'pdf-layer';
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';
    const annoCanvas = document.createElement('canvas');
    annoCanvas.className = 'anno-layer';

    pageEl.appendChild(pdfCanvas);
    pageEl.appendChild(textLayerDiv);
    pageEl.appendChild(annoCanvas);
    row.appendChild(scratchL);
    row.appendChild(pageEl);
    row.appendChild(scratchR);
    pagesEl.appendChild(row);

    setGutterStyle(pageEl);
  }

  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageEl = entry.target;
        if (entry.isIntersecting) {
          renderPage(pageEl);
        } else {
          // Free memory for pages far off-screen.
          clearPageCanvas(pageEl);
        }
      }
      updateCurrentPage();
    },
    { root: viewer, rootMargin: '900px 0px' }
  );

  pagesEl.querySelectorAll('.page').forEach((p) => io.observe(p));
  pageTotal.textContent = `/ ${state.numPages}`;
  pageInput.value = '1';
  positionShoveButtons();
}

function clearPageCanvas(pageEl) {
  if (pageEl.dataset.rendered !== 'true') return;
  const c = pageEl.querySelector('.pdf-layer');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  c.width = 0;
  c.height = 0;
  pageEl.dataset.rendered = 'false';
  if (pageEl._renderTask) {
    try { pageEl._renderTask.cancel(); } catch {}
    pageEl._renderTask = null;
  }
  if (pageEl._textLayerTask) {
    try { pageEl._textLayerTask.cancel(); } catch {}
    pageEl._textLayerTask = null;
  }
  const t = pageEl.querySelector('.text-layer');
  t.innerHTML = '';
  t.style.transform = '';

  // Free the scratch-margin canvases too — they're reallocated lazily by
  // layoutScratchForPage() the next time this page becomes visible.
  const row = pageEl.parentElement;
  clearScratchCanvas(row.querySelector('.scratch-left'));
  clearScratchCanvas(row.querySelector('.scratch-right'));
}

async function renderPage(pageEl) {
  if (pageEl.dataset.rendered === 'true' || pageEl._rendering) return;
  pageEl._rendering = true;
  const num = +pageEl.dataset.page;
  try {
    const page = await state.pdf.getPage(num);
    const viewport = page.getViewport({ scale: state.scale, rotation: state.rotation });
    const dpr = window.devicePixelRatio || 1;

    const pdfCanvas = pageEl.querySelector('.pdf-layer');
    const annoCanvas = pageEl.querySelector('.anno-layer');
    for (const c of [pdfCanvas, annoCanvas]) {
      c.width = Math.floor(viewport.width * dpr);
      c.height = Math.floor(viewport.height * dpr);
      c.style.width = viewport.width + 'px';
      c.style.height = viewport.height + 'px';
    }

    const ctx = pdfCanvas.getContext('2d');
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    pageEl._renderTask = task;
    await task.promise;
    pageEl._renderTask = null;
    pageEl.dataset.rendered = 'true';

    redrawAnnotations(pageEl);
    layoutScratchForPage(pageEl);
    // Not awaited: text isn't needed for the page to count as "rendered",
    // and it shouldn't block canvas rendering of the next visible page.
    renderTextLayer(pageEl, page).catch((err) => {
      if (err && err.name !== 'AbortException') console.error(err);
    });
  } catch (err) {
    if (err && err.name !== 'RenderingCancelledException') console.error(err);
  } finally {
    pageEl._rendering = false;
  }
}

// Builds the invisible, selectable text overlay for a page using pdf.js's
// TextLayer. Text spans are laid out by pdf.js in the page's *unrotated*
// space (it has no concept of our on-the-fly rotation), so we render at
// rotation 0 and then apply our own CSS matrix — using the same rotation
// convention as normToCanvas — to map that box onto the rotated page.
function rotationTransformCss(rot, w, h) {
  switch (rot) {
    case 90: return `matrix(0,1,-1,0,${h},0)`;
    case 180: return `matrix(-1,0,0,-1,${w},${h})`;
    case 270: return `matrix(0,-1,1,0,0,${w})`;
    default: return '';
  }
}

async function renderTextLayer(pageEl, page) {
  const container = pageEl.querySelector('.text-layer');
  if (pageEl._textLayerTask) {
    try { pageEl._textLayerTask.cancel(); } catch {}
    pageEl._textLayerTask = null;
  }
  container.innerHTML = '';
  container.style.transform = '';
  container.style.setProperty('--scale-factor', state.scale);

  // Text content doesn't depend on scale/rotation — cache it on the page
  // element so re-renders (zoom, scroll back into view) skip re-extraction.
  if (!pageEl._textContent) {
    pageEl._textContent = await page.getTextContent();
  }

  const unrotatedViewport = page.getViewport({ scale: state.scale, rotation: 0 });
  const task = new pdfjsLib.TextLayer({
    textContentSource: pageEl._textContent,
    container,
    viewport: unrotatedViewport,
  });
  pageEl._textLayerTask = task;
  await task.render();
  pageEl._textLayerTask = null;

  container.style.transformOrigin = '0 0';
  container.style.transform = rotationTransformCss(
    state.rotation,
    unrotatedViewport.width,
    unrotatedViewport.height
  );
}

// Re-render everything currently on/near screen (after zoom).
function renderVisible() {
  const vr = viewer.getBoundingClientRect();
  pagesEl.querySelectorAll('.page').forEach((pageEl) => {
    const r = pageEl.getBoundingClientRect();
    const near = r.bottom > vr.top - 900 && r.top < vr.bottom + 900;
    if (near) renderPage(pageEl);
  });
}

// ============================================================
// Annotation rendering
// ============================================================
function pageCssSize(pageEl) {
  return {
    w: parseFloat(pageEl.style.width),
    h: parseFloat(pageEl.style.height),
  };
}

function redrawAnnotations(pageEl) {
  const num = +pageEl.dataset.page;
  const c = pageEl.querySelector('.anno-layer');
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  const strokes = state.annotations[num];
  if (!strokes || !strokes.length) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { w, h } = pageCssSize(pageEl);
  for (const stroke of strokes) drawStroke(ctx, stroke, w, h, state.rotation);
}

// rot is explicit (not read from state.rotation) so the same function
// draws scratch-margin strokes too — margins never rotate with the page.
function drawStroke(ctx, stroke, vw, vh, rot) {
  const pts = stroke.points;
  if (!pts.length) return;
  const P = (pt) => normToCanvas(pt[0], pt[1], vw, vh, rot);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color;

  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    const [x0, y0] = P(pts[0]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = P(pts[i]);
      ctx.lineTo(x, y);
    }
    if (pts.length === 1) ctx.lineTo(x0 + 0.1, y0);
    ctx.stroke();
  } else {
    // Pen: variable width per segment based on pressure.
    ctx.globalAlpha = 1;
    if (pts.length === 1) {
      const [x, y] = P(pts[0]);
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.arc(x, y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const pAvg = (a[2] + b[2]) / 2;
        ctx.lineWidth = stroke.width * pressureScale(stroke, pAvg);
        const [ax, ay] = P(a);
        const [bx, by] = P(b);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function pressureScale(stroke, p) {
  // Pen from a tablet reports 0..1. Mouse uses a constant width.
  if (!stroke.pen) return 1;
  return 0.35 + p * 1.35;
}

// ============================================================
// Scratch margins ("rascunho") + shove layout
// Each page-row holds a page plus a blank, drawable margin on either
// side — whatever room is left between the page and the viewer's edges.
// Their strokes are stored in state.annotations under pseudo page keys
// 'L<n>'/'R<n>' (n = page number), normalized [0..1] against that
// margin's own current width/height, exactly like page strokes — so they
// reuse drawStroke/undo/redo/save unchanged, and simply re-scale when the
// margin is resized (zoom, window resize, or a "shove").
// ============================================================

// How the leftover width beside a page (at its current CSS size) splits
// between its two margins, given the current shove state.
function gutterWidths(pageWpx) {
  const avail = Math.max(0, viewer.clientWidth - pageWpx);
  if (state.shove === 'left') return { left: 0, right: avail };
  if (state.shove === 'right') return { left: avail, right: 0 };
  return { left: avail / 2, right: avail / 2 };
}

// Cheap: just sets the CSS box size for a page's two margins, so the row
// looks right immediately — even for pages whose margins have no pixel
// buffer allocated yet (see layoutScratchForPage).
function setGutterStyle(pageEl) {
  const row = pageEl.parentElement;
  const scratchL = row.querySelector('.scratch-left');
  const scratchR = row.querySelector('.scratch-right');
  const pageW = parseFloat(pageEl.style.width) || 0;
  const pageH = parseFloat(pageEl.style.height) || 0;
  const { left, right } = gutterWidths(pageW);
  scratchL.style.width = left + 'px';
  scratchL.style.height = pageH + 'px';
  scratchR.style.width = right + 'px';
  scratchR.style.height = pageH + 'px';
}

// Full: (re)allocates the pixel buffer for a *rendered* page's margins
// and redraws their strokes. Mirrors renderPage/clearPageCanvas's lazy
// lifecycle for the pdf/anno layers — an off-screen page's margins stay
// deallocated until it scrolls back into view.
function layoutScratchForPage(pageEl) {
  setGutterStyle(pageEl);
  const row = pageEl.parentElement;
  const num = pageEl.dataset.page;
  syncScratchCanvas(row.querySelector('.scratch-left'), 'L' + num);
  syncScratchCanvas(row.querySelector('.scratch-right'), 'R' + num);
}

function syncScratchCanvas(canvas, key) {
  const wCss = parseFloat(canvas.style.width) || 0;
  const hCss = parseFloat(canvas.style.height) || 0;
  if (wCss < 1 || hCss < 1) {
    clearScratchCanvas(canvas);
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(wCss * dpr));
  canvas.height = Math.max(1, Math.round(hCss * dpr));
  redrawScratch(canvas, key);
}

function clearScratchCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function redrawScratch(canvas, key) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = state.annotations[key];
  if (!strokes || !strokes.length) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = parseFloat(canvas.style.width) || 0;
  const h = parseFloat(canvas.style.height) || 0;
  for (const s of strokes) drawStroke(ctx, s, w, h, 0); // margins never rotate
}

// Re-applies gutters/pixel buffers to every currently-rendered page (e.g.
// after a shove toggle or a window resize) — not-yet-rendered pages just
// get the cheap style update and pick up the rest when they scroll into view.
function relayoutScratchAll() {
  pagesEl.querySelectorAll('.page').forEach((pageEl) => {
    if (pageEl.dataset.rendered === 'true') layoutScratchForPage(pageEl);
    else setGutterStyle(pageEl);
  });
}

function toggleShove(side) {
  if (!state.pdf) return;
  state.shove = state.shove === side ? 'none' : side;
  updateShoveButtons();
  relayoutScratchAll();
  markDirty();
}

function updateShoveButtons() {
  if (!shoveLeftBtn) return;
  // Buttons are inverted from their screen position on purpose: the
  // left-edge button pushes the page right, the right-edge button pushes
  // it left — so each highlights when ITS action, not its side, is active.
  shoveLeftBtn.classList.toggle('active', state.shove === 'right');
  shoveRightBtn.classList.toggle('active', state.shove === 'left');
}

// Fixed-position buttons anchored to the viewer's on-screen rect — same
// approach as positionPopover(), so they track window resizes/fullscreen
// without scrolling with the document.
function positionShoveButtons() {
  if (!shoveLeftBtn) return;
  const has = !!state.pdf;
  shoveLeftBtn.hidden = !has;
  shoveRightBtn.hidden = !has;
  if (!has) return;
  const r = viewer.getBoundingClientRect();
  const top = r.top + r.height / 2 + 'px';
  shoveLeftBtn.style.top = top;
  shoveRightBtn.style.top = top;
  shoveLeftBtn.style.left = r.left + 6 + 'px';
  shoveRightBtn.style.right = window.innerWidth - r.right + 6 + 'px';
}

// ============================================================
// Drawing input (pen / highlighter / eraser)
// Handlers are delegated once on #pages (not per canvas) so a single
// continuous drag can span multiple "surfaces": pages stacked
// vertically, and — since scratch margins exist beside every page — the
// blank space to either side of one. When the pointer crosses a seam
// (page-to-page, or page-to-margin), the stroke is split into two
// pieces, each ending/starting exactly at the shared boundary, so the
// line reads as unbroken even though each piece is stored against its
// own surface: a page number, or 'L'/'R' + page number for its margins.
// ============================================================
let activeDraw = null; // { tool, color, width, pen, bySurface, lastSurface, lastX, lastY }
let erasingState = null; // { touched: Map<key, beforeStrokes> }

// Finds whichever drawable surface (a page, or one of its two side
// margins) the given viewport point falls on. Returns null if the point
// isn't over any surface (e.g. a margin with no room at this zoom/shove).
function surfaceAt(clientX, clientY) {
  const rows = pagesEl.querySelectorAll('.page-row');
  let row = null;
  for (const r of rows) {
    if (clientY < r.getBoundingClientRect().bottom) { row = r; break; }
  }
  if (!row) row = rows[rows.length - 1] || null;
  if (!row) return null;

  const pageEl = row.querySelector('.page');
  const num = pageEl.dataset.page;
  const pr = pageEl.getBoundingClientRect();

  if (clientX < pr.left || clientX > pr.right) {
    const onLeft = clientX < pr.left;
    const canvas = row.querySelector(onLeft ? '.scratch-left' : '.scratch-right');
    const w = parseFloat(canvas.style.width) || 0;
    const h = parseFloat(canvas.style.height) || 0;
    if (w < 2 || h < 2) return null;
    return { type: 'scratch', canvas, pageEl, key: (onLeft ? 'L' : 'R') + num, w, h, rot: 0 };
  }
  return {
    type: 'page',
    canvas: pageEl.querySelector('.anno-layer'),
    pageEl,
    key: +num,
    w: parseFloat(pageEl.style.width),
    h: parseFloat(pageEl.style.height),
    rot: state.rotation,
  };
}

function normPointOnSurface(surface, clientX, clientY) {
  const r = surface.canvas.getBoundingClientRect();
  return canvasToNorm(clientX - r.left, clientY - r.top, surface.w, surface.h, surface.rot);
}

function surfaceCtxFor(surface) {
  const ctx = surface.canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function redrawSurface(surface) {
  if (surface.type === 'page') redrawAnnotations(surface.pageEl);
  else redrawScratch(surface.canvas, surface.key);
}

// Lazily starts (and snapshots the "before" state for) this surface's
// piece of the in-progress multi-surface stroke.
function surfaceStrokeEntry(draw, surface) {
  let entry = draw.bySurface.get(surface.canvas);
  if (!entry) {
    entry = {
      before: clone(state.annotations[surface.key] || []),
      stroke: { tool: draw.tool, color: draw.color, width: draw.width, pen: draw.pen, points: [] },
      surface,
    };
    draw.bySurface.set(surface.canvas, entry);
  }
  return entry;
}

function drawSegmentLive(surface, draw, fromPt, toPt) {
  const ctx = surfaceCtxFor(surface);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = draw.color;
  ctx.globalAlpha = draw.tool === 'highlighter' ? 0.32 : 1;
  ctx.lineWidth = draw.tool === 'highlighter'
    ? draw.width
    : draw.width * pressureScale(draw, (fromPt[2] + toPt[2]) / 2);
  const [px, py] = normToCanvas(fromPt[0], fromPt[1], surface.w, surface.h, surface.rot);
  const [cx, cy] = normToCanvas(toPt[0], toPt[1], surface.w, surface.h, surface.rot);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  ctx.restore();
}

function onDrawPointerDown(e) {
  if (!['pen', 'highlighter', 'eraser'].includes(state.tool)) return;
  const surface = surfaceAt(e.clientX, e.clientY);
  if (!surface) return;
  e.preventDefault();
  pagesEl.setPointerCapture(e.pointerId);

  if (state.tool === 'eraser') {
    erasingState = { touched: new Map() };
    eraseAtSurface(surface, e.clientX, e.clientY, erasingState);
    return;
  }

  const isPen = e.pointerType === 'pen';
  activeDraw = {
    tool: state.tool,
    color: state.tool === 'pen' ? state.penColor : state.hlColor,
    width: state.tool === 'pen' ? state.penWidth : state.hlWidth,
    pen: isPen,
    bySurface: new Map(),
    lastSurface: surface,
    lastX: e.clientX,
    lastY: e.clientY,
  };
  const entry = surfaceStrokeEntry(activeDraw, surface);
  const [x, y] = normPointOnSurface(surface, e.clientX, e.clientY);
  entry.stroke.points.push([x, y, isPen ? e.pressure || 0.5 : 0.5]);
}

function onDrawPointerMove(e) {
  if (erasingState) {
    const surface = surfaceAt(e.clientX, e.clientY);
    if (surface) eraseAtSurface(surface, e.clientX, e.clientY, erasingState);
    return;
  }
  if (!activeDraw) return;
  e.preventDefault();
  const draw = activeDraw;
  // Coalesced events give every sample the tablet produced between
  // frames — this is what makes lines faithful and precise.
  const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];

  for (const ev of events.length ? events : [e]) {
    const pr = draw.pen ? ev.pressure || 0.5 : 0.5;
    const surface = surfaceAt(ev.clientX, ev.clientY);
    if (!surface) { draw.lastX = ev.clientX; draw.lastY = ev.clientY; continue; }

    if (surface.canvas === draw.lastSurface.canvas) {
      const entry = surfaceStrokeEntry(draw, surface);
      const prev = entry.stroke.points[entry.stroke.points.length - 1];
      const [x, y] = normPointOnSurface(surface, ev.clientX, ev.clientY);
      const cur = [x, y, pr];
      entry.stroke.points.push(cur);
      drawSegmentLive(surface, draw, prev, cur);
    } else {
      // Crossed into a different surface: another page (scrolled past a
      // page seam), or into/out of a side margin (drawn past the page's
      // own edge). Each surface is its own canvas, so the line can only
      // ever be drawn up to that canvas's own edge. Stop the old
      // surface's piece exactly at the shared boundary and start the new
      // one there too, so the only visible break is that fixed seam.
      const oldSurface = draw.lastSurface;
      const newSurface = surface;
      const oldR = oldSurface.canvas.getBoundingClientRect();
      const newR = newSurface.canvas.getBoundingClientRect();
      const dx = ev.clientX - draw.lastX;
      const dy = ev.clientY - draw.lastY;

      // Pages stack vertically (row to row); a page and its own margins
      // sit side by side within the same row. Figure out which axis
      // separates the two surfaces so the seam is cut on the right edge.
      const stackedVertically = oldR.bottom <= newR.top || oldR.top >= newR.bottom;
      let seamOldX, seamOldY, seamNewX, seamNewY;
      if (stackedVertically) {
        const movingDown = oldR.bottom <= newR.top;
        const oldEdge = movingDown ? oldR.bottom : oldR.top;
        const newEdge = movingDown ? newR.top : newR.bottom;
        const t1 = dy !== 0 ? (oldEdge - draw.lastY) / dy : 0.5;
        const t2 = dy !== 0 ? (newEdge - draw.lastY) / dy : 0.5;
        seamOldX = draw.lastX + t1 * dx; seamOldY = oldEdge;
        seamNewX = draw.lastX + t2 * dx; seamNewY = newEdge;
      } else {
        const movingRight = oldR.right <= newR.left;
        const oldEdge = movingRight ? oldR.right : oldR.left;
        const newEdge = movingRight ? newR.left : newR.right;
        const t1 = dx !== 0 ? (oldEdge - draw.lastX) / dx : 0.5;
        const t2 = dx !== 0 ? (newEdge - draw.lastX) / dx : 0.5;
        seamOldY = draw.lastY + t1 * dy; seamOldX = oldEdge;
        seamNewY = draw.lastY + t2 * dy; seamNewX = newEdge;
      }

      const oldEntry = surfaceStrokeEntry(draw, oldSurface);
      const prevOld = oldEntry.stroke.points[oldEntry.stroke.points.length - 1];
      const seamOld = [...normPointOnSurface(oldSurface, seamOldX, seamOldY), pr];
      oldEntry.stroke.points.push(seamOld);
      drawSegmentLive(oldSurface, draw, prevOld, seamOld);

      const newEntry = surfaceStrokeEntry(draw, newSurface);
      const seamNew = [...normPointOnSurface(newSurface, seamNewX, seamNewY), pr];
      newEntry.stroke.points.push(seamNew);
      const cur = [...normPointOnSurface(newSurface, ev.clientX, ev.clientY), pr];
      newEntry.stroke.points.push(cur);
      drawSegmentLive(newSurface, draw, seamNew, cur);

      draw.lastSurface = newSurface;
    }
    draw.lastX = ev.clientX;
    draw.lastY = ev.clientY;
  }
}

function onDrawPointerUp() {
  if (activeDraw) {
    const entries = [];
    for (const [, entry] of activeDraw.bySurface) {
      if (!entry.stroke.points.length) continue;
      const key = entry.surface.key;
      (state.annotations[key] ||= []).push(entry.stroke);
      entries.push({ pageNum: key, strokes: entry.before });
      redrawSurface(entry.surface); // clean composited redraw (fixes highlighter overlap)
    }
    if (entries.length) {
      pushUndo(entries);
      markDirty();
    }
    activeDraw = null;
  }
  if (erasingState) {
    const entries = [];
    for (const [key, before] of erasingState.touched) entries.push({ pageNum: key, strokes: before });
    if (entries.length) {
      pushUndo(entries);
      markDirty();
    }
    erasingState = null;
  }
}

function initDrawingInput() {
  pagesEl.addEventListener('pointerdown', onDrawPointerDown);
  pagesEl.addEventListener('pointermove', onDrawPointerMove);
  pagesEl.addEventListener('pointerup', onDrawPointerUp);
  pagesEl.addEventListener('pointercancel', onDrawPointerUp);
}

function eraseAtSurface(surface, clientX, clientY, erasing) {
  const key = surface.key;
  const strokes = state.annotations[key];
  if (!strokes || !strokes.length) return;
  const r = surface.canvas.getBoundingClientRect();
  const ex = clientX - r.left;
  const ey = clientY - r.top;
  const rad = state.eraserWidth / 2;
  const { w, h, rot } = surface;
  const before = strokes.length;
  const filtered = strokes.filter((s) => {
    return !s.points.some((pt) => {
      const [cx, cy] = normToCanvas(pt[0], pt[1], w, h, rot);
      const dx = cx - ex;
      const dy = cy - ey;
      return dx * dx + dy * dy <= rad * rad;
    });
  });
  if (filtered.length !== before) {
    if (!erasing.touched.has(key)) erasing.touched.set(key, clone(strokes));
    state.annotations[key] = filtered;
    redrawSurface(surface);
    markDirty();
  }
}

// ============================================================
// Undo / redo
// ============================================================
function clone(x) {
  return JSON.parse(JSON.stringify(x));
}
// Each undo/redo entry is an array of { pageNum, strokes } — usually one
// page, but a stroke that crosses a page boundary touches two, and both
// must undo/redo together as a single atomic operation.
function pushUndo(entries) {
  if (!entries || !entries.length) return;
  state.undoStack.push(entries);
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack = [];
}
function undo() {
  const entries = state.undoStack.pop();
  if (!entries) return;
  const redoEntries = entries.map(({ pageNum }) => ({
    pageNum,
    strokes: clone(state.annotations[pageNum] || []),
  }));
  for (const { pageNum, strokes } of entries) {
    state.annotations[pageNum] = clone(strokes);
    redrawPage(pageNum);
  }
  state.redoStack.push(redoEntries);
  markDirty();
}
function redo() {
  const entries = state.redoStack.pop();
  if (!entries) return;
  const undoEntries = entries.map(({ pageNum }) => ({
    pageNum,
    strokes: clone(state.annotations[pageNum] || []),
  }));
  for (const { pageNum, strokes } of entries) {
    state.annotations[pageNum] = clone(strokes);
    redrawPage(pageNum);
  }
  state.undoStack.push(undoEntries);
  markDirty();
}
// `key` is either a page number or a scratch-margin pseudo-key
// ('L<n>'/'R<n>') — see the "Scratch margins" section above.
function redrawPage(key) {
  if (typeof key === 'string') {
    const side = key[0]; // 'L' or 'R'
    const num = key.slice(1);
    const pageEl = pagesEl.querySelector(`.page[data-page="${num}"]`);
    if (!pageEl || pageEl.dataset.rendered !== 'true') return;
    const row = pageEl.parentElement;
    const canvas = row.querySelector(side === 'L' ? '.scratch-left' : '.scratch-right');
    if (canvas && canvas.width > 0 && canvas.height > 0) redrawScratch(canvas, key);
    return;
  }
  const el = pagesEl.querySelector(`.page[data-page="${key}"]`);
  if (el && el.dataset.rendered === 'true') redrawAnnotations(el);
}
function clearCurrentPage() {
  const num = getCurrentPage();
  const before = clone(state.annotations[num] || []);
  if (!before.length) return;
  pushUndo([{ pageNum: num, strokes: before }]);
  state.annotations[num] = [];
  redrawPage(num);
  markDirty();
  toast(`Anotacoes da pagina ${num} removidas`);
}

// ============================================================
// Save (manual — no autosave; Ctrl+S writes the sidecar)
// ============================================================
function markDirty() {
  if (!state.pdf) return;
  state.dirty = true;
  updateTitle();
}

function updateTitle() {
  const dot = state.dirty ? '● ' : '';
  const name = state.pdfName ? `${state.pdfName} — ` : '';
  document.title = `${dot}${name}Death PDF`;
  if (saveBtn) saveBtn.classList.toggle('dirty', state.dirty);
  updateActiveTabDot();
  window.dpdf.setDirty?.(anyDirty());
}

async function save() {
  if (!state.pdfPath) {
    toast('Nenhum PDF aberto.');
    return;
  }
  const res = await window.dpdf.saveAnnotations(state.pdfPath, {
    version: 1,
    theme: state.theme,
    rotation: state.rotation,
    shove: state.shove,
    annotations: state.annotations,
  });
  if (res === true) {
    state.dirty = false;
    updateTitle();
    toast('Anotacoes salvas.');
  } else {
    toast('Falha ao salvar as anotacoes.');
  }
}

// ============================================================
// Zoom & navigation
// ============================================================
function setScale(newScale, anchor = true) {
  newScale = Math.max(0.25, Math.min(5, newScale));
  if (!state.pdf) return;
  const prevScroll = viewer.scrollTop;
  const prevScale = state.scale;
  state.scale = newScale;
  zoomLabel.textContent = Math.round(newScale * 100) + '%';

  // Resize placeholders, drop rendered canvases so they re-render sharp.
  pagesEl.querySelectorAll('.page').forEach((pageEl) => {
    const dim = dispDim(+pageEl.dataset.page);
    pageEl.style.width = dim.w * newScale + 'px';
    pageEl.style.height = dim.h * newScale + 'px';
    clearPageCanvas(pageEl);
    setGutterStyle(pageEl);
  });

  if (anchor && prevScale) {
    viewer.scrollTop = prevScroll * (newScale / prevScale);
  }
  renderVisible();
}

function zoomIn() { setScale(state.scale * 1.15); }
function zoomOut() { setScale(state.scale / 1.15); }

function fitWidth() {
  if (!state.pdf) return;
  const dim = dispDim(getCurrentPage()) || dispDim(1);
  const avail = viewer.clientWidth - 48; // padding room
  const scale = avail / dim.w;
  state.scale = scale;
  zoomLabel.textContent = Math.round(scale * 100) + '%';
  buildPages();
  renderVisible();
}

function getCurrentPage() {
  return Math.max(1, Math.min(state.numPages, parseInt(pageInput.value, 10) || 1));
}
function updateCurrentPage() {
  const mid = viewer.scrollTop + viewer.clientHeight / 2;
  let best = 1;
  const pages = pagesEl.querySelectorAll('.page');
  for (const p of pages) {
    if (p.offsetTop <= mid) best = +p.dataset.page;
    else break;
  }
  if (document.activeElement !== pageInput) pageInput.value = String(best);
}
function goToPage(num) {
  num = Math.max(1, Math.min(state.numPages, num));
  const el = pagesEl.querySelector(`.page[data-page="${num}"]`);
  if (el) viewer.scrollTo({ top: el.offsetTop - 22, behavior: 'smooth' });
}

// ============================================================
// PDF themes
// ============================================================
function setTheme(id) {
  if (!PDF_THEMES.some((t) => t.id === id)) id = 'none';
  state.theme = id;
  if (id !== 'none') state.lastDark = id;
  viewer.dataset.theme = id;
  darkBtn.classList.toggle('on', id !== 'none');
  localStorage.setItem('deathpdf.theme', id);
  renderThemeMenu();
}
// Quick toggle bound to the keyboard shortcut: flips between the current
// dark theme and "none".
function toggleTheme() {
  setTheme(state.theme === 'none' ? state.lastDark || 'invert' : 'none');
}

function renderThemeMenu() {
  if (!themeMenu) return;
  themeMenu.innerHTML = '';
  for (const t of PDF_THEMES) {
    const b = document.createElement('button');
    b.className = 'popover-item' + (t.id === state.theme ? ' active' : '');
    b.textContent = t.label;
    b.addEventListener('click', () => {
      setTheme(t.id);
      closeThemeMenu();
    });
    themeMenu.appendChild(b);
  }
}
function toggleThemeMenu() {
  if (themeMenu.hidden) {
    closeUiThemeMenu();
    renderThemeMenu();
    positionPopover(themeMenu, darkBtn);
    themeMenu.hidden = false;
  } else {
    closeThemeMenu();
  }
}
function closeThemeMenu() {
  if (themeMenu) themeMenu.hidden = true;
}

// ============================================================
// Interface (app chrome) theme
// ============================================================
function setUiTheme(id) {
  if (!UI_THEMES.some((t) => t.id === id)) id = DEFAULT_UI_THEME;
  document.documentElement.dataset.uiTheme = id;
  localStorage.setItem('deathpdf.uiTheme', id);
  renderUiThemeMenu();
}

function renderUiThemeMenu() {
  if (!uiThemeMenu) return;
  const current = document.documentElement.dataset.uiTheme || DEFAULT_UI_THEME;
  uiThemeMenu.innerHTML = '';
  for (const t of UI_THEMES) {
    const b = document.createElement('button');
    b.className = 'popover-item' + (t.id === current ? ' active' : '');
    b.textContent = t.label;
    b.addEventListener('click', () => {
      setUiTheme(t.id);
      closeUiThemeMenu();
    });
    uiThemeMenu.appendChild(b);
  }
}
function toggleUiThemeMenu() {
  if (uiThemeMenu.hidden) {
    closeThemeMenu();
    renderUiThemeMenu();
    positionPopover(uiThemeMenu, uiThemeBtn);
    uiThemeMenu.hidden = false;
  } else {
    closeUiThemeMenu();
  }
}
function closeUiThemeMenu() {
  if (uiThemeMenu) uiThemeMenu.hidden = true;
}

// ============================================================
// Rotation
// ============================================================
function rotate(deltaDeg) {
  if (!state.pdf) return;
  state.rotation = ((state.rotation + deltaDeg) % 360 + 360) % 360;
  const cur = getCurrentPage();
  buildPages(); // placeholders resize with swapped dimensions
  renderVisible();
  goToPage(cur);
  markDirty();
  toast(`Rotacao: ${state.rotation}°`);
}

// ============================================================
// Fullscreen
// ============================================================
function toggleFullscreen() {
  window.dpdf.toggleFullscreen();
}

// ============================================================
// Tools
// ============================================================
function setTool(tool) {
  state.tool = tool;
  viewer.dataset.tool = tool;
  document
    .querySelectorAll('#tool-group .tool')
    .forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  renderToolOptions();
}

// Pressing a tool's shortcut (or clicking its button) again turns it off,
// falling back to the default select tool.
function toggleTool(tool) {
  setTool(state.tool === tool ? 'select' : tool);
}

function renderToolOptions() {
  const drawing = ['pen', 'highlighter', 'eraser'].includes(state.tool);
  toolOptions.hidden = !drawing;
  if (!drawing) return;

  swatchesEl.innerHTML = '';
  if (state.tool === 'eraser') {
    widthLabel.textContent = 'Tamanho';
    widthSlider.min = 6;
    widthSlider.max = 80;
    widthSlider.value = state.eraserWidth;
  } else {
    const palette = state.tool === 'pen' ? PEN_PALETTE : HL_PALETTE;
    const current = state.tool === 'pen' ? state.penColor : state.hlColor;
    palette.forEach((color) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (color === current ? ' active' : '');
      b.style.background = color;
      b.title = color;
      b.addEventListener('click', () => {
        if (state.tool === 'pen') state.penColor = color;
        else state.hlColor = color;
        renderToolOptions();
      });
      swatchesEl.appendChild(b);
    });
    widthLabel.textContent = 'Espessura';
    if (state.tool === 'pen') {
      widthSlider.min = 1; widthSlider.max = 24; widthSlider.value = state.penWidth;
    } else {
      widthSlider.min = 6; widthSlider.max = 48; widthSlider.value = state.hlWidth;
    }
  }
}

widthSlider.addEventListener('input', () => {
  const v = +widthSlider.value;
  if (state.tool === 'pen') state.penWidth = v;
  else if (state.tool === 'highlighter') state.hlWidth = v;
  else if (state.tool === 'eraser') state.eraserWidth = v;
});

// ============================================================
// Export annotated PDF (flattened, via pdf-lib)
// ============================================================
async function exportPdf() {
  if (!state.pdf || !window.PDFLib) return;
  toast('Gerando PDF...');
  try {
    const { PDFDocument, rgb, LineCapStyle, degrees } = window.PDFLib;
    const doc = await PDFDocument.load(state.pdfBytes);
    const pages = doc.getPages();

    // Carry the current viewing rotation into the exported file. Strokes
    // are stored in the page's original space, so applying /Rotate keeps
    // page content and annotations rotating together, matching the app.
    if (state.rotation) {
      for (const page of pages) {
        const base = page.getRotation().angle || 0;
        page.setRotation(degrees((base + state.rotation) % 360));
      }
    }

    for (const [numStr, strokes] of Object.entries(state.annotations)) {
      const num = +numStr;
      const page = pages[num - 1];
      if (!page || !strokes.length) continue;
      const { width: pw, height: ph } = page.getSize();
      for (const s of strokes) {
        const col = hexToRgb(s.color);
        const opacity = s.tool === 'highlighter' ? 0.32 : 1;
        const pts = s.points;
        if (pts.length === 1) {
          page.drawCircle({
            x: pts[0][0] * pw,
            y: ph - pts[0][1] * ph,
            size: s.width / 2,
            color: rgb(col.r, col.g, col.b),
            opacity,
          });
          continue;
        }
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const thickness =
            s.tool === 'highlighter'
              ? s.width
              : s.width * (s.pen ? 0.35 + ((a[2] + b[2]) / 2) * 1.35 : 1);
          page.drawLine({
            start: { x: a[0] * pw, y: ph - a[1] * ph },
            end: { x: b[0] * pw, y: ph - b[1] * ph },
            thickness,
            color: rgb(col.r, col.g, col.b),
            opacity,
            lineCap: LineCapStyle.Round,
          });
        }
      }
    }

    const bytes = await doc.save();
    const suggested = state.pdfName.replace(/\.pdf$/i, '') + ' (anotado).pdf';
    const saved = await window.dpdf.exportPdf(suggested, bytes);
    toast(saved ? 'PDF exportado.' : 'Exportacao cancelada.');
  } catch (err) {
    console.error(err);
    toast('Falha ao exportar o PDF.');
  }
}

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  const n = parseInt(m.length === 3 ? m.split('').map((c) => c + c).join('') : m, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// ============================================================
// Action dispatch
// ============================================================
const ACTIONS = {
  open: openViaDialog,
  toolSelect: () => setTool('select'),
  toolPen: () => toggleTool('pen'),
  toolHighlighter: () => toggleTool('highlighter'),
  toolEraser: () => toggleTool('eraser'),
  toolPan: () => toggleTool('pan'),
  darkMode: toggleTheme,
  themeMenu: toggleThemeMenu,
  uiThemeMenu: toggleUiThemeMenu,
  undo,
  redo,
  zoomIn,
  zoomOut,
  fitWidth,
  nextPage: () => goToPage(getCurrentPage() + 1),
  prevPage: () => goToPage(getCurrentPage() - 1),
  rotateCW: () => rotate(90),
  rotateCCW: () => rotate(-90),
  shoveLeft: () => toggleShove('left'),
  shoveRight: () => toggleShove('right'),
  save,
  export: exportPdf,
  fullscreen: toggleFullscreen,
  settings: openSettings,
  clearPage: clearCurrentPage,
  closeTab: () => { if (activeTabId != null) closeTab(activeTabId); },
  nextTab: () => cycleTab(1),
  prevTab: () => cycleTab(-1),
};

// Toolbar buttons
document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    ACTIONS[btn.dataset.action]?.();
  });
});
document.querySelectorAll('#tool-group .tool').forEach((btn) => {
  btn.addEventListener('click', () => toggleTool(btn.dataset.tool));
});

// ============================================================
// Keyboard shortcuts
// ============================================================
let spaceHeld = false;
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';
  if (rebinding) return; // handled by modal

  // Hold Space = temporary pan.
  if (e.key === ' ' && !typing && !e.repeat) {
    e.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      state.prevTool = state.tool;
      setTool('pan');
    }
    return;
  }

  if (typing) return;
  const combo = comboFromEvent(e);
  if (!combo) return;

  if (combo === 'esc' && ((themeMenu && !themeMenu.hidden) || (uiThemeMenu && !uiThemeMenu.hidden))) {
    closeThemeMenu();
    closeUiThemeMenu();
    return;
  }

  const action = Object.keys(shortcuts).find((a) => shortcuts[a] && shortcuts[a] === combo);
  if (action && ACTIONS[action]) {
    e.preventDefault();
    ACTIONS[action]();
    return;
  }

  // Bare arrow keys move/scroll the document — available in every tool,
  // including the drawing tools where dragging is reserved for the pen.
  if (['up', 'down', 'left', 'right'].includes(combo)) {
    e.preventDefault();
    scrollByArrow(combo);
  }
});

function scrollByArrow(dir) {
  const stepV = Math.max(80, viewer.clientHeight * 0.16);
  const stepH = 120;
  if (dir === 'up') viewer.scrollTop -= stepV;
  else if (dir === 'down') viewer.scrollTop += stepV;
  else if (dir === 'left') viewer.scrollLeft -= stepH;
  else if (dir === 'right') viewer.scrollLeft += stepH;
}

// Close the theme popovers when clicking anywhere outside them.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.theme-wrap')) {
    closeThemeMenu();
    closeUiThemeMenu();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && spaceHeld) {
    spaceHeld = false;
    setTool(state.prevTool || 'select');
  }
});

// ============================================================
// Pan (drag-to-scroll) with the hand tool
// ============================================================
let panning = null;
viewer.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'pan') return;
  panning = { x: e.clientX, y: e.clientY, top: viewer.scrollTop, left: viewer.scrollLeft };
  viewer.classList.add('grabbing');
});
window.addEventListener('pointermove', (e) => {
  if (!panning) return;
  viewer.scrollTop = panning.top - (e.clientY - panning.y);
  viewer.scrollLeft = panning.left - (e.clientX - panning.x);
});
window.addEventListener('pointerup', () => {
  panning = null;
  viewer.classList.remove('grabbing');
});

// Ctrl+wheel zoom
viewer.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    }
  },
  { passive: false }
);

viewer.addEventListener('scroll', () => updateCurrentPage());
pageInput.addEventListener('change', () => goToPage(getCurrentPage()));
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { goToPage(getCurrentPage()); pageInput.blur(); }
});

window.addEventListener('resize', () => {
  clearTimeout(window._rz);
  window._rz = setTimeout(() => {
    positionShoveButtons();
    if (!state.pdf) return;
    relayoutScratchAll(); // margin widths depend on viewer.clientWidth
    renderVisible();
  }, 200);
});

// ============================================================
// Settings modal
// ============================================================
const backdrop = document.getElementById('modal-backdrop');
const shortcutList = document.getElementById('shortcut-list');
let rebinding = null;

function openSettings() {
  renderShortcutList();
  backdrop.hidden = false;
}
function closeSettings() {
  backdrop.hidden = true;
  rebinding = null;
}

function renderShortcutList() {
  shortcutList.innerHTML = '';
  for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
    const row = document.createElement('div');
    row.className = 'sc-row';
    const name = document.createElement('span');
    name.className = 'sc-name';
    name.textContent = ACTION_LABELS[action] || action;
    const key = document.createElement('button');
    key.className = 'sc-key';
    key.textContent = prettyCombo(shortcuts[action]);
    key.addEventListener('click', () => startRebind(action, key));
    row.append(name, key);
    shortcutList.appendChild(row);
  }
}

function startRebind(action, keyEl) {
  document.querySelectorAll('.sc-key.listening').forEach((el) => {
    el.classList.remove('listening');
  });
  keyEl.classList.add('listening');
  keyEl.textContent = 'Pressione...';
  rebinding = { action, keyEl };
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!rebinding) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      rebinding.keyEl.classList.remove('listening');
      rebinding.keyEl.textContent = prettyCombo(shortcuts[rebinding.action]);
      rebinding = null;
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return; // wait for a non-modifier key
    // Clear this combo from any other action to avoid duplicates.
    for (const a of Object.keys(shortcuts)) {
      if (shortcuts[a] === combo && a !== rebinding.action) shortcuts[a] = '';
    }
    shortcuts[rebinding.action] = combo;
    saveShortcuts();
    rebinding = null;
    renderShortcutList();
    updateHints();
  },
  true // capture, so it runs before the global shortcut handler
);

document.getElementById('close-settings').addEventListener('click', closeSettings);
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSettings(); });
document.getElementById('reset-shortcuts').addEventListener('click', () => {
  shortcuts = { ...DEFAULT_SHORTCUTS };
  saveShortcuts();
  renderShortcutList();
  updateHints();
});

function updateHints() {
  const openHint = document.getElementById('hint-open');
  if (openHint) openHint.textContent = prettyCombo(shortcuts.open);
}

// ============================================================
// Boot
// ============================================================
initDrawingInput();
setTool('select');
updateHints();

// Restore the last-used interface theme (global preference).
setUiTheme(localStorage.getItem('deathpdf.uiTheme') || DEFAULT_UI_THEME);

// Restore the last-used theme (global preference) before any PDF loads.
const savedTheme = localStorage.getItem('deathpdf.theme') || 'none';
state.theme = savedTheme;
if (savedTheme !== 'none') state.lastDark = savedTheme;
viewer.dataset.theme = savedTheme;
darkBtn.classList.toggle('on', savedTheme !== 'none');
renderThemeMenu();
updateTitle();

window.dpdf.onOpenFilePath(async (p) => {
  const res = await window.dpdf.readPdf(p);
  if (res) await loadPdf(res);
});
