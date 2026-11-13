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
  tool: 'pan',
  prevTool: 'pan',
  theme: 'none', // PDF viewing theme id (see PDF_THEMES)
  lastDark: 'invert', // remembered dark theme for the quick toggle
  penColor: '#ececec',
  penWidth: 3,
  hlColor: '#f5c518',
  hlWidth: 18,
  eraserWidth: 22,
  annotations: {}, // { [pageNum]: [stroke] }
  textHighlights: {}, // { [pageNum]: [{ id, start, end, color, note }] } — real
                       // text marks (select text, mark it), as opposed to the
                       // freehand `highlighter` tool's drawn strokes above.
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
  find: 'ctrl+f',
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
  find: 'Pesquisar no PDF',
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
const brushPreview = document.getElementById('brush-preview');
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
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
const findPrevBtn = document.getElementById('find-prev-btn');
const findNextBtn = document.getElementById('find-next-btn');
const findCloseBtn = document.getElementById('find-close-btn');
const selectionToolbar = document.getElementById('selection-toolbar');
const selectionSwatchesEl = document.getElementById('selection-swatches');
const selectionNoteBtn = document.getElementById('selection-note-btn');
const hlNotePopover = document.getElementById('hl-note-popover');
const hlPopoverSwatchesEl = document.getElementById('hl-popover-swatches');
const hlNoteTextarea = document.getElementById('hl-note-textarea');
const hlNoteRemoveBtn = document.getElementById('hl-note-remove-btn');
const hlNoteSaveBtn = document.getElementById('hl-note-save-btn');

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
  'textHighlights', 'undoStack', 'redoStack', 'dirty',
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
  closeFindBar(); // search state/highlights belong to the outgoing document
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
  closeFindBar();
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
  state.textHighlights = {};
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
  closeFindBar();
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
    state.textHighlights = {};
    state.undoStack = [];
    state.redoStack = [];
    state.rotation = 0;
    state.shove = 'none';
    state.dirty = false;
    const saved = await window.dpdf.loadAnnotations(path);
    if (saved && saved.annotations) {
      state.annotations = saved.annotations;
      if (saved.textHighlights) state.textHighlights = saved.textHighlights;
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
  clearPageSearchHighlights(pageEl); // the spans they anchored to are gone
  const hlLayer = pageEl.querySelector('.highlight-layer');
  if (hlLayer) hlLayer.innerHTML = ''; // same — its rects were measured off those spans

  // Free the scratch-margin canvases too — they're reallocated lazily by
  // layoutScratchForPage() the next time this page becomes visible.
  const row = pageEl.parentElement;
  clearScratchCanvas(row.querySelector('.scratch-left'));
  clearScratchCanvas(row.querySelector('.scratch-right'));
}

async function renderPage(pageEl, opts = {}) {
  if (pageEl.dataset.rendered === 'true' || pageEl._rendering) {
    // Already rendered (or another caller is mid-render): the canvas is
    // handled, but a caller that specifically needs the text layer (e.g.
    // jumping to a search match) still has to wait for it.
    if (pageEl._rendering) {
      while (pageEl._rendering) await new Promise((r) => setTimeout(r, 30));
    }
    if (opts.awaitText && pageEl._textLayerPromise) {
      try { await pageEl._textLayerPromise; } catch {}
    }
    return;
  }
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
    // Not awaited by default: text isn't needed for the page to count as
    // "rendered", and it shouldn't block canvas rendering of the next
    // visible page. Callers that specifically need the text layer (e.g.
    // jumping to a search match) can pass { awaitText: true }.
    const textPromise = renderTextLayer(pageEl, page).catch((err) => {
      if (err && err.name !== 'AbortException') console.error(err);
    });
    pageEl._textLayerPromise = textPromise;
    if (opts.awaitText) await textPromise;
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

  // The text layer was just rebuilt from scratch (innerHTML = '' above),
  // so any search highlights anchored to its old spans are gone — repaint
  // this page's matches against the fresh ones.
  if (searchState.open && searchState.term) refreshPageSearchHighlights(pageEl);
  // Same story for persisted text highlights — their Ranges anchored to
  // the torn-down spans too, so rebuild them against the fresh ones.
  redrawTextHighlights(pageEl);
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
      entries.push({ pageNum: key, kind: 'strokes', list: entry.before });
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
    for (const [key, before] of erasingState.touched) entries.push({ pageNum: key, kind: 'strokes', list: before });
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
  pagesEl.addEventListener('pointermove', onBrushPreviewMove);
  pagesEl.addEventListener('pointerenter', onBrushPreviewMove);
  pagesEl.addEventListener('pointerleave', hideBrushPreview);
}

// ============================================================
// Brush-size preview (highlighter / eraser)
// ============================================================
// A ring centered on the pointer, sized to the exact diameter of the area
// the next highlighter stroke or eraser touch will cover — same idea as a
// round brush cursor in a paint program, so users can see how big a swipe
// will land before committing to it. Only shown for tools whose "size"
// is otherwise invisible until you've already drawn/erased something.
function currentBrushDiameter() {
  return state.tool === 'eraser' ? state.eraserWidth : state.hlWidth;
}
function updateBrushPreviewSize() {
  if (brushPreview.hidden) return;
  const d = currentBrushDiameter();
  brushPreview.style.width = d + 'px';
  brushPreview.style.height = d + 'px';
}
function onBrushPreviewMove(e) {
  if (state.tool !== 'highlighter' && state.tool !== 'eraser') {
    hideBrushPreview();
    return;
  }
  brushPreview.className = state.tool === 'eraser' ? 'brush-eraser' : 'brush-highlighter';
  brushPreview.style.left = e.clientX + 'px';
  brushPreview.style.top = e.clientY + 'px';
  if (brushPreview.hidden) {
    brushPreview.hidden = false;
    updateBrushPreviewSize();
  }
}
function hideBrushPreview() {
  brushPreview.hidden = true;
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
// Each undo/redo entry is an array of { pageNum, kind, list } — usually one
// entry, but a stroke that crosses a page boundary touches two surfaces,
// and both must undo/redo together as a single atomic operation. `kind`
// picks which per-page store the entry belongs to ('strokes' — pen/
// highlighter/eraser ink — or 'hl' — real text highlights/notes), so pen
// strokes and text marks share one linear history: Ctrl+Z undoes
// whichever kind of change happened last.
function storeFor(kind) {
  return kind === 'hl' ? state.textHighlights : state.annotations;
}
function redrawFor(kind, pageNum) {
  if (kind === 'hl') redrawAllTextHighlightsOnPage(pageNum);
  else redrawPage(pageNum);
}
function pushUndo(entries) {
  if (!entries || !entries.length) return;
  state.undoStack.push(entries);
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack = [];
}
function undo() {
  const entries = state.undoStack.pop();
  if (!entries) return;
  const redoEntries = entries.map(({ pageNum, kind }) => ({
    pageNum,
    kind,
    list: clone(storeFor(kind)[pageNum] || []),
  }));
  for (const { pageNum, kind, list } of entries) {
    storeFor(kind)[pageNum] = clone(list);
    redrawFor(kind, pageNum);
  }
  state.redoStack.push(redoEntries);
  markDirty();
}
function redo() {
  const entries = state.redoStack.pop();
  if (!entries) return;
  const undoEntries = entries.map(({ pageNum, kind }) => ({
    pageNum,
    kind,
    list: clone(storeFor(kind)[pageNum] || []),
  }));
  for (const { pageNum, kind, list } of entries) {
    storeFor(kind)[pageNum] = clone(list);
    redrawFor(kind, pageNum);
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
  pushUndo([{ pageNum: num, kind: 'strokes', list: before }]);
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
    textHighlights: state.textHighlights,
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
  // Whether a highlight's text gets the solid-black overlay (see
  // redrawTextHighlights) depends on this theme — but toggling it doesn't
  // itself re-render any page, so nothing would refresh without this.
  refreshAllTextHighlights();
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
  if (tool !== 'highlighter' && tool !== 'eraser') hideBrushPreview();
  if (tool !== 'select') {
    // Marking only makes sense while the select tool is live — drop any
    // leftover native selection and its toolbar so it doesn't linger,
    // invisible, into whatever tool comes next.
    window.getSelection()?.removeAllRanges();
    hideSelectionToolbar();
  }
}

// Pressing a tool's shortcut (or clicking its button) again turns it off,
// falling back to the default hand (pan) tool.
function toggleTool(tool) {
  setTool(state.tool === tool ? 'pan' : tool);
}

function renderToolOptions() {
  const drawing = ['pen', 'highlighter', 'eraser'].includes(state.tool);
  toolOptions.hidden = !drawing;
  if (!drawing) return;

  swatchesEl.innerHTML = '';
  if (state.tool === 'eraser') {
    widthLabel.textContent = 'Tamanho';
    widthSlider.min = 6;
    widthSlider.max = 200;
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
      widthSlider.min = 6; widthSlider.max = 120; widthSlider.value = state.hlWidth;
    }
  }
}

widthSlider.addEventListener('input', () => {
  const v = +widthSlider.value;
  if (state.tool === 'pen') state.penWidth = v;
  else if (state.tool === 'highlighter') state.hlWidth = v;
  else if (state.tool === 'eraser') state.eraserWidth = v;
  updateBrushPreviewSize();
});
// Once the drag/keyboard adjustment ends, release focus so the slider
// doesn't keep swallowing keyboard shortcuts (tool switching, arrows, etc.)
// the way a focused <input> normally would.
widthSlider.addEventListener('change', () => widthSlider.blur());

// ============================================================
// Export annotated PDF (flattened, via pdf-lib)
// ============================================================
// Computes a page's text highlights in PDF point space (top-down, origin at
// the page's own top-left — same convention drawLine()/drawCircle() above
// convert from) for export. Reuses the exact same rendering pdf.js uses
// on-screen (a fresh TextLayer at scale 1 rotation 0, off in a detached
// corner of the document) rather than approximating glyph geometry by
// hand, so the exported rectangles land exactly where they show in-app.
async function highlightRectsForExport(pageNum) {
  const list = state.textHighlights[pageNum];
  if (!list || !list.length) return [];
  const page = await state.pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed; left:-99999px; top:0; line-height:1; visibility:hidden;';
  container.style.width = viewport.width + 'px';
  container.style.height = viewport.height + 'px';
  container.style.setProperty('--scale-factor', 1); // TextLayer spans size themselves off this
  document.body.appendChild(container);
  try {
    const textContent = await page.getTextContent();
    const task = new pdfjsLib.TextLayer({ textContentSource: textContent, container, viewport });
    await task.render();
    const { segs } = buildDomText(collectTextNodes(container));
    const pr = container.getBoundingClientRect();
    const out = [];
    for (const hl of list) {
      const ranges = rangesForMatch(segs, hl.start, hl.end);
      for (const r of ranges) {
        for (const rect of r.getClientRects()) {
          if (rect.width < 0.5 || rect.height < 0.5) continue;
          out.push({
            x: rect.left - pr.left,
            y: rect.top - pr.top,
            width: rect.width,
            height: rect.height,
            color: hl.color,
          });
        }
      }
    }
    return out;
  } finally {
    container.remove();
  }
}

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

    for (const [numStr, list] of Object.entries(state.textHighlights)) {
      const num = +numStr;
      const page = pages[num - 1];
      if (!page || !list.length) continue;
      const { height: ph } = page.getSize();
      const rects = await highlightRectsForExport(num);
      for (const rect of rects) {
        const col = hexToRgb(rect.color);
        page.drawRectangle({
          x: rect.x,
          y: ph - rect.y - rect.height,
          width: rect.width,
          height: rect.height,
          color: rgb(col.r, col.g, col.b),
          opacity: 0.32,
        });
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
    const suggested = state.pdfName.replace(/\.(pdf|epub)$/i, '') + ' (anotado).pdf';
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
// Search (Ctrl+F) — find text across the whole document
//
// Match highlighting uses the CSS Custom Highlight API (`::highlight()`)
// against Range objects anchored to the text-layer's own DOM text nodes,
// so it never mutates that layer (which stays free for selection/copy and
// gets torn down and rebuilt on every zoom/rotation/scroll-out).
//
// Counting/navigation ("N of M"), though, has to work across pages that
// aren't rendered at all — so it runs on a separate, DOM-independent copy
// of each page's text pulled straight from pdf.js's getTextContent(). The
// two are kept in step because a rendered page's DOM text (spans, walked
// in order) reproduces the same string as its getTextContent() items
// (walked in order): same source, same order, so the Nth match found in
// one is the Nth match found in the other.
// ============================================================
const SEARCH_ALL_HL = 'pdf-search-all';
const SEARCH_CUR_HL = 'pdf-search-current';
const highlightsSupported = typeof Highlight !== 'undefined' && !!window.CSS?.highlights;
const allMatchesHL = highlightsSupported ? new Highlight() : null;
const currentMatchHL = highlightsSupported ? new Highlight() : null;
if (highlightsSupported) {
  CSS.highlights.set(SEARCH_ALL_HL, allMatchesHL);
  CSS.highlights.set(SEARCH_CUR_HL, currentMatchHL);
}

const searchState = {
  open: false,
  term: '', // already lowercased
  total: 0,
  current: -1, // 0-based index into the whole document's matches
  byPage: [], // match count per page, index 0 = page 1
  currentPageNum: null,
  currentLocalIndex: -1, // index of the current match within its own page
  currentRanges: null, // Range[] for the current match (rarely more than one)
};

// Case- and accent-insensitive, like a browser's own PDF viewer (searching
// "algoritmo" should also find "Algoritmo" and "algorítmo"). NFD splits each
// accented letter into its base letter + combining accent mark(s), which are
// then stripped — "á" -> "á" -> "a". Every accented character in
// Portuguese decomposes into exactly one base letter plus marks in the
// U+0300-U+036F block, so this always maps 1 original character to exactly
// 1 result character — the position math in buildDomText()/rangesForMatch()
// (which maps offsets in this normalized string back onto un-normalized DOM
// text) relies on that alignment.
function normalizeSearchText(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Page text for counting/locating matches — independent of whether the
// page is actually rendered. Reuses the cache renderTextLayer() already
// keeps on rendered pages instead of re-extracting.
async function getPageText(pageNum) {
  const pageEl = pagesEl.querySelector(`.page[data-page="${pageNum}"]`);
  if (pageEl && pageEl._textContent) {
    return pageEl._textContent.items.map((it) => it.str || '').join('');
  }
  const page = await state.pdf.getPage(pageNum);
  const tc = await page.getTextContent();
  if (pageEl) pageEl._textContent = tc;
  return tc.items.map((it) => it.str || '').join('');
}

function countMatches(text, term) {
  if (!term) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = text.indexOf(term, idx);
    if (found === -1) break;
    count++;
    idx = found + term.length;
  }
  return count;
}

// Walks every text node under a text-layer container in document order —
// the same order pdf.js appended its spans in, which is the same order
// getTextContent() lists its items in.
function collectTextNodes(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

// Concatenates those text nodes into one case/accent-normalized string plus
// a map back from character offsets to (node, offset-within-node), so a
// match found in the concatenated string can be turned back into real DOM
// Ranges. segs' offsets are measured on the *un-normalized* text, which is
// safe only because normalizeSearchText() preserves character count 1:1.
function buildDomText(nodes) {
  let text = '';
  const segs = [];
  for (const node of nodes) {
    const val = node.nodeValue || '';
    if (!val) continue;
    const start = text.length;
    text += val;
    segs.push({ node, start, end: text.length });
  }
  return { text: normalizeSearchText(text), segs };
}

// A match's [start, end) range in the concatenated string usually falls
// within one text node, but can straddle a boundary (e.g. a span break
// pdf.js inserted mid-word) — split it into one Range per node it touches.
function rangesForMatch(segs, start, end) {
  const ranges = [];
  for (const seg of segs) {
    const s = Math.max(start, seg.start);
    const e = Math.min(end, seg.end);
    if (s >= e) continue;
    const r = document.createRange();
    r.setStart(seg.node, s - seg.start);
    r.setEnd(seg.node, e - seg.start);
    ranges.push(r);
  }
  return ranges;
}

function findAllRanges(text, segs, term) {
  const out = [];
  if (!term) return out;
  let idx = 0;
  while (true) {
    const found = text.indexOf(term, idx);
    if (found === -1) break;
    out.push(rangesForMatch(segs, found, found + term.length));
    idx = found + term.length;
  }
  return out;
}

// Drops a rendered page's ranges from the "all matches" highlight (its
// text-layer spans are about to be, or already were, torn down).
function clearPageSearchHighlights(pageEl) {
  if (allMatchesHL && pageEl._searchRanges) {
    for (const r of pageEl._searchRanges) allMatchesHL.delete(r);
  }
  pageEl._searchRanges = null;
  if (+pageEl.dataset.page === searchState.currentPageNum && currentMatchHL) {
    currentMatchHL.clear();
  }
}

// Recomputes and repaints this rendered page's matches. Called whenever
// its text layer is (re)built while a search is active — zoom, rotation,
// and scrolling back into view all rebuild it from scratch.
function refreshPageSearchHighlights(pageEl) {
  clearPageSearchHighlights(pageEl);
  if (!allMatchesHL || !searchState.term) return;
  const container = pageEl.querySelector('.text-layer');
  if (!container) return;
  const { text, segs } = buildDomText(collectTextNodes(container));
  const matches = findAllRanges(text, segs, searchState.term);
  pageEl._searchRanges = [];
  for (const group of matches) {
    for (const r of group) {
      allMatchesHL.add(r);
      pageEl._searchRanges.push(r);
    }
  }
  const num = +pageEl.dataset.page;
  if (searchState.currentPageNum === num) {
    const group = matches[searchState.currentLocalIndex];
    if (group) {
      currentMatchHL.clear();
      for (const r of group) currentMatchHL.add(r);
      searchState.currentRanges = group;
    }
  }
}

function clearCurrentMatchHighlight() {
  if (currentMatchHL) currentMatchHL.clear();
  searchState.currentPageNum = null;
  searchState.currentLocalIndex = -1;
  searchState.currentRanges = null;
}

// Turns a global match index into which page it's on and its position
// within that page's own matches, using the running per-page counts.
function locateMatch(globalIndex) {
  let acc = 0;
  for (let p = 1; p <= state.numPages; p++) {
    const c = searchState.byPage[p - 1] || 0;
    if (globalIndex < acc + c) return { pageNum: p, localIndex: globalIndex - acc };
    acc += c;
  }
  return null;
}

let searchBuildToken = 0;
async function rebuildMatchCounts() {
  const token = ++searchBuildToken;
  const term = searchState.term;
  searchState.byPage = new Array(state.numPages).fill(0);
  searchState.total = 0;
  searchState.current = -1;
  clearCurrentMatchHighlight();
  if (!term || !state.pdf) { updateFindUi(); return; }
  for (let p = 1; p <= state.numPages; p++) {
    const raw = await getPageText(p);
    if (token !== searchBuildToken) return; // a newer query superseded this scan
    searchState.byPage[p - 1] = countMatches(normalizeSearchText(raw), term);
    searchState.total += searchState.byPage[p - 1];
    if (p % 8 === 0) updateFindUi(); // live counter while a big doc is still scanning
  }
  if (token !== searchBuildToken) return;
  // Deliberately no auto-jump/auto-select here: typing (or reopening with a
  // term already set) should only mark the matches that are already on
  // screen — the first "go to a match" is whatever the user asks for via
  // next/prev, exactly like a browser's find bar.
  updateFindUi();
  refreshAllRenderedPagesHighlights();
}

// Repaints "all matches" highlights on every page currently rendered (i.e.
// already has a text layer in the DOM) — used right after the term changes,
// so matches already on screen light up without jumping/scrolling anywhere.
// Pages that render later (user scrolls to them) pick up highlights via the
// hook at the end of renderTextLayer().
function refreshAllRenderedPagesHighlights() {
  pagesEl.querySelectorAll('.page[data-rendered="true"]').forEach((pageEl) => {
    refreshPageSearchHighlights(pageEl);
  });
}

// Scrolls just enough to center the current match, without fighting any
// in-flight scroll (the caller already got the page roughly on-screen).
function scrollToCurrentRange() {
  const ranges = searchState.currentRanges;
  if (!ranges || !ranges.length) return;
  const rect = ranges[0].getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const vr = viewer.getBoundingClientRect();
  const delta = (rect.top + rect.height / 2) - (vr.top + vr.height / 2);
  viewer.scrollTo({ top: viewer.scrollTop + delta, behavior: 'smooth' });
}

async function jumpToCurrentMatch() {
  updateFindUi();
  if (searchState.current < 0) {
    clearCurrentMatchHighlight();
    return;
  }
  const loc = locateMatch(searchState.current);
  if (!loc) return;
  searchState.currentPageNum = loc.pageNum;
  searchState.currentLocalIndex = loc.localIndex;

  const pageEl = pagesEl.querySelector(`.page[data-page="${loc.pageNum}"]`);
  if (!pageEl) return;
  // Get the page roughly on-screen first (instant — no animation to race
  // against) so the IntersectionObserver/renderPage below has it in range.
  viewer.scrollTop = pageEl.offsetTop - 22;
  await renderPage(pageEl, { awaitText: true });
  refreshPageSearchHighlights(pageEl);
  scrollToCurrentRange();
}

function nextMatch() {
  if (!searchState.total) return;
  // No match selected yet (just opened/typed) — next goes to the first one.
  searchState.current = searchState.current < 0 ? 0 : (searchState.current + 1) % searchState.total;
  jumpToCurrentMatch();
}
function prevMatch() {
  if (!searchState.total) return;
  // No match selected yet — previous wraps around to the last one.
  searchState.current = searchState.current < 0
    ? searchState.total - 1
    : (searchState.current - 1 + searchState.total) % searchState.total;
  jumpToCurrentMatch();
}

function updateFindUi() {
  findCount.textContent = searchState.term ? `${searchState.current + 1}/${searchState.total}` : '';
  findInput.classList.toggle('no-match', !!searchState.term && searchState.total === 0);
  findPrevBtn.disabled = findNextBtn.disabled = !searchState.total;
}

// Fixed to the viewer's own on-screen rect (same trick as positionPopover
// and positionShoveButtons), so it tracks resizes without scrolling away.
function positionFindBar() {
  const r = viewer.getBoundingClientRect();
  findBar.style.top = r.top + 10 + 'px';
  findBar.style.right = window.innerWidth - r.right + 14 + 'px';
}

function openFindBar() {
  if (!state.pdf) return;
  searchState.open = true;
  findBar.hidden = false;
  positionFindBar();
  findInput.focus();
  findInput.select();
  if (searchState.term) rebuildMatchCounts();
}
function closeFindBar() {
  findBar.hidden = true;
  searchState.open = false;
  searchState.term = '';
  searchState.total = 0;
  searchState.current = -1;
  searchState.byPage = [];
  findInput.value = '';
  clearCurrentMatchHighlight();
  if (allMatchesHL) allMatchesHL.clear();
  pagesEl.querySelectorAll('.page').forEach((el) => { el._searchRanges = null; });
  updateFindUi(); // otherwise the count label keeps showing the last search's tally
}
function toggleFindBar() {
  if (findBar.hidden) openFindBar();
  else closeFindBar();
}

let findDebounce = null;
findInput.addEventListener('input', () => {
  clearTimeout(findDebounce);
  findDebounce = setTimeout(() => {
    searchState.term = normalizeSearchText(findInput.value.trim());
    rebuildMatchCounts();
  }, 180);
});
findInput.addEventListener('keydown', (e) => {
  // Let the find shortcut close the bar even while it holds focus (the
  // global handler below ignores keydowns while an <input> is focused).
  if (comboFromEvent(e) === shortcuts.find) { e.preventDefault(); closeFindBar(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) prevMatch(); else nextMatch();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindBar();
  }
});
findPrevBtn.addEventListener('click', prevMatch);
findNextBtn.addEventListener('click', nextMatch);
findCloseBtn.addEventListener('click', closeFindBar);

// ============================================================
// Text highlights — select real text and mark it (unlike the freehand
// `highlighter` tool, which just draws strokes), plus an optional note
// attached to the marked spot. Like search matches, a highlight is stored
// as a [start, end) character range into the page's own concatenated text
// (buildDomText/collectTextNodes/rangesForMatch, all defined above for
// search) — not pixel coordinates — so it survives zoom, rotation and
// reload without drifting, and gets rebuilt against a page's *current*
// text-layer DOM every time renderTextLayer() (re)builds it.
// ============================================================
let hlIdSeq = 0;
function nextHlId() {
  return 'h' + (++hlIdSeq) + '_' + Math.random().toString(36).slice(2, 8);
}

function pageElByNum(num) {
  return pagesEl.querySelector(`.page[data-page="${num}"]`);
}

function ensureHighlightLayer(pageEl) {
  let layer = pageEl.querySelector('.highlight-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'highlight-layer';
    pageEl.insertBefore(layer, pageEl.querySelector('.text-layer'));
  }
  return layer;
}

// A Range boundary isn't always (text node, char offset) — double-clicking
// a word (or Ctrl+A, or a boundary that lands exactly at a node's edge)
// often gets reported as (element, child index) instead. Walk from that
// element/index to the actual text node it points at, so offsetsFromRange
// below always has a text node to match against buildDomText()'s segs.
function normalizeToTextBoundary(node, offset) {
  if (node.nodeType === Node.TEXT_NODE) return { node, offset };
  let child = offset < node.childNodes.length ? node.childNodes[offset] : null;
  if (child) {
    while (child && child.nodeType !== Node.TEXT_NODE) child = child.firstChild;
    if (child) return { node: child, offset: 0 };
  }
  // Off the end (or nothing but empty elements forward) — fall back to the
  // end of whatever text precedes this point.
  child = offset > 0 ? node.childNodes[offset - 1] : node.lastChild;
  while (child && child.nodeType !== Node.TEXT_NODE) child = child.lastChild;
  return child ? { node: child, offset: child.nodeValue.length } : null;
}

// Maps a live Selection Range — anchored inside one page's text-layer — to
// [start, end) character offsets in that page's concatenated text.
function offsetsFromRange(container, range) {
  const { segs } = buildDomText(collectTextNodes(container));
  const startPt = normalizeToTextBoundary(range.startContainer, range.startOffset);
  const endPt = normalizeToTextBoundary(range.endContainer, range.endOffset);
  if (!startPt || !endPt) return null;
  let start = null;
  let end = null;
  for (const seg of segs) {
    if (seg.node === startPt.node) start = seg.start + startPt.offset;
    if (seg.node === endPt.node) end = seg.start + endPt.offset;
  }
  if (start == null || end == null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

// A Range's on-screen rects, translated into the page's own local box (CSS
// px, matching where .text-hl / .hl-note-marker are positioned).
function rectsRelativeToPage(range, pageEl) {
  const pr = pageEl.getBoundingClientRect();
  const out = [];
  for (const r of range.getClientRects()) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    out.push({ left: r.left - pr.left, top: r.top - pr.top, width: r.width, height: r.height });
  }
  return out;
}

function findHighlight(pageNum, id) {
  return (state.textHighlights[pageNum] || []).find((h) => h.id === id) || null;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// A page's highlights must never overlap — marking text that's already (in
// full or in part) under an existing highlight recolors/extends that one
// instead of stacking a second mark on top of it. Removes every highlight
// the new [start,end) touches and returns the union range (plus whichever
// note survives, so a plain recolor over a noted highlight doesn't lose it).
function mergeOverlappingHighlights(pageNum, start, end) {
  const list = state.textHighlights[pageNum];
  if (!list || !list.length) return { start, end, note: null };
  const keep = [];
  let note = null;
  for (const h of list) {
    if (rangesOverlap(start, end, h.start, h.end)) {
      start = Math.min(start, h.start);
      end = Math.max(end, h.end);
      if (!note && h.note) note = h.note;
    } else {
      keep.push(h);
    }
  }
  state.textHighlights[pageNum] = keep;
  return { start, end, note };
}

function createHighlight(pageNum, start, end, color, note) {
  const before = clone(state.textHighlights[pageNum] || []);
  const merged = mergeOverlappingHighlights(pageNum, start, end);
  const id = nextHlId();
  (state.textHighlights[pageNum] ||= []).push({
    id,
    start: merged.start,
    end: merged.end,
    color,
    note: note || merged.note || null,
  });
  pushUndo([{ pageNum, kind: 'hl', list: before }]);
  redrawAllTextHighlightsOnPage(pageNum);
  markDirty();
  return id;
}
function updateHighlight(pageNum, id, patch) {
  const hl = findHighlight(pageNum, id);
  if (!hl) return;
  const before = clone(state.textHighlights[pageNum] || []);
  Object.assign(hl, patch);
  pushUndo([{ pageNum, kind: 'hl', list: before }]);
  redrawAllTextHighlightsOnPage(pageNum);
  markDirty();
}
function removeHighlight(pageNum, id) {
  const list = state.textHighlights[pageNum];
  if (!list) return;
  const idx = list.findIndex((h) => h.id === id);
  if (idx === -1) return;
  const before = clone(list);
  list.splice(idx, 1);
  pushUndo([{ pageNum, kind: 'hl', list: before }]);
  redrawAllTextHighlightsOnPage(pageNum);
  markDirty();
}

const NOTE_ICON_SVG = '<svg viewBox="0 0 24 24"><path d="M4 4h16v12H9l-5 4z"/></svg>';

// (Re)paints one page's stored highlights against its *current* text-layer
// DOM — called after every renderTextLayer() rebuild (zoom/rotation/scroll
// back into view), the same hook point search highlights use.
// The text layer is normally fully transparent — the visible glyphs are
// baked into the PDF canvas underneath, which the dark/inverted PDF themes
// flip to near-white via a CSS filter on .pdf-layer (the text layer itself
// is untouched by that filter). A highlighter color under white-on-dark
// text is unreadable, so the highlighted characters get their own text
// surfaced: wrap them in a solid-black span (same font/size/weight as the
// pdf.js span it wraps — only color changes, so it lines up exactly with
// the glyph underneath) that sits on top of the highlight regardless of
// theme. Idempotent — safe to call again on a container it already marked
// (redrawTextHighlights re-runs on every create/edit/remove, not just on a
// fresh text-layer rebuild).
function clearHlTextMarks(container) {
  container.querySelectorAll('span.hl-text').forEach((el) => el.replaceWith(...el.childNodes));
  container.normalize();
}

function redrawTextHighlights(pageEl) {
  const num = +pageEl.dataset.page;
  const layer = ensureHighlightLayer(pageEl);
  layer.innerHTML = '';
  const container = pageEl.querySelector('.text-layer');
  clearHlTextMarks(container);
  const list = state.textHighlights[num];
  if (!list || !list.length) return;
  const { segs } = buildDomText(collectTextNodes(container));
  for (const hl of list) {
    const ranges = rangesForMatch(segs, hl.start, hl.end);
    const rects = ranges.flatMap((r) => rectsRelativeToPage(r, pageEl));
    if (!rects.length) continue;
    for (const rect of rects) {
      const div = document.createElement('div');
      div.className = 'text-hl';
      div.style.left = rect.left + 'px';
      div.style.top = rect.top + 'px';
      div.style.width = rect.width + 'px';
      div.style.height = rect.height + 'px';
      div.style.background = hl.color;
      div.dataset.hlId = hl.id;
      if (hl.note) div.title = hl.note;
      layer.appendChild(div);
    }
    if (hl.note) {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'hl-note-marker';
      const first = rects[0];
      marker.style.left = Math.max(0, first.left) + 'px';
      marker.style.top = Math.max(0, first.top - 15) + 'px';
      marker.dataset.hlId = hl.id;
      marker.title = hl.note;
      marker.innerHTML = NOTE_ICON_SVG;
      layer.appendChild(marker);
    }
    // Only worth it on the dark/inverted PDF themes — that's the one case
    // the underlying glyphs turn white and a highlighter color under them
    // gets unreadable. In the normal (unfiltered, already-black-on-white)
    // theme the original text is already legible, and the overlay would
    // just double-print the same glyph on top of itself for no benefit.
    if (state.theme === 'none') continue;
    // Each sub-range from rangesForMatch is confined to a single text
    // node, so surroundContents() can't hit its "partially selected a
    // non-text node" error here — the try/catch is a defensive fallback
    // only (the colored rect above still marks the text either way).
    for (const r of ranges) {
      try {
        const mark = document.createElement('span');
        mark.className = 'hl-text';
        r.surroundContents(mark);
      } catch {}
    }
  }
}
function redrawAllTextHighlightsOnPage(num) {
  const el = pageElByNum(num);
  if (el && el.dataset.rendered === 'true') redrawTextHighlights(el);
}
// Called on theme changes (see setTheme) — whether the solid-black text
// overlay applies depends on the theme, but switching theme doesn't
// re-render pages on its own, so every rendered page needs a fresh pass.
function refreshAllTextHighlights() {
  pagesEl.querySelectorAll('.page').forEach((el) => {
    if (el.dataset.rendered === 'true') redrawTextHighlights(el);
  });
}

// ---- Floating popovers: selection toolbar + note editor ----

// Clamps a fixed-position floating panel to the viewport, preferring just
// above the anchor rect (falling back to below it if there's no room) —
// same idea as positionFindBar()/positionPopover(), just anchored to an
// arbitrary rect instead of a fixed toolbar button.
function positionFloating(el, rect) {
  const margin = 8;
  let top = rect.top - el.offsetHeight - margin;
  if (top < 8) top = rect.bottom + margin;
  top = Math.min(top, window.innerHeight - el.offsetHeight - 8);
  let left = rect.left;
  left = Math.min(Math.max(8, left), window.innerWidth - el.offsetWidth - 8);
  el.style.top = Math.max(8, top) + 'px';
  el.style.left = left + 'px';
}

let pendingSelection = null; // { pageNum, start, end, range } — a fresh, unsaved selection

// Reads the current window Selection, restricted to a single page's
// text-layer (cross-page marking isn't supported — a selection spanning
// two pages is simply ignored, same as an empty one).
// A Range boundary container is a text node in the common case, but can
// also be the element itself (see normalizeToTextBoundary above) — this
// finds ".text-layer" ancestor either way instead of assuming a text node.
function closestElement(node) {
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function currentPageTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startLayer = closestElement(range.startContainer)?.closest('.text-layer');
  const endLayer = closestElement(range.endContainer)?.closest('.text-layer');
  if (!startLayer || !endLayer || startLayer !== endLayer) return null;
  const pageEl = startLayer.closest('.page');
  if (!pageEl) return null;
  const offs = offsetsFromRange(startLayer, range);
  if (!offs || offs.start === offs.end) return null;
  return { pageNum: +pageEl.dataset.page, start: offs.start, end: offs.end, range };
}

function renderSelectionSwatches() {
  selectionSwatchesEl.innerHTML = '';
  for (const color of HL_PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hl-swatch';
    b.style.background = color;
    b.title = 'Marcar com esta cor';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!pendingSelection) return;
      createHighlight(pendingSelection.pageNum, pendingSelection.start, pendingSelection.end, color, null);
      window.getSelection()?.removeAllRanges();
      hideSelectionToolbar();
      toast('Texto marcado.');
    });
    selectionSwatchesEl.appendChild(b);
  }
}
renderSelectionSwatches();

function showSelectionToolbar(rect) {
  selectionToolbar.hidden = false;
  positionFloating(selectionToolbar, rect);
}
function hideSelectionToolbar() {
  selectionToolbar.hidden = true;
  pendingSelection = null;
}

function updateSelectionToolbar() {
  if (state.tool !== 'select' || !hlNotePopover.hidden) { hideSelectionToolbar(); return; }
  const sel = currentPageTextSelection();
  if (!sel) { hideSelectionToolbar(); return; }
  pendingSelection = sel;
  const rects = sel.range.getClientRects();
  const rect = rects[rects.length - 1] || sel.range.getBoundingClientRect();
  showSelectionToolbar(rect);
}
let selDebounce = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(selDebounce);
  selDebounce = setTimeout(updateSelectionToolbar, 40);
});
// mousedown on the toolbar would otherwise collapse the page's own text
// selection before the swatch's click handler gets to read it.
selectionToolbar.addEventListener('mousedown', (e) => e.preventDefault());

let noteEditorCtx = null; // { mode: 'new'|'edit', pageNum, start, end, color, note, id? }

function renderHlPopoverSwatches(activeColor) {
  hlPopoverSwatchesEl.innerHTML = '';
  for (const color of HL_PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hl-swatch' + (color === activeColor ? ' active' : '');
    b.style.background = color;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!noteEditorCtx) return;
      noteEditorCtx.color = color;
      renderHlPopoverSwatches(color);
    });
    hlPopoverSwatchesEl.appendChild(b);
  }
}

function openNoteEditor(ctx, anchorRect) {
  hideSelectionToolbar();
  noteEditorCtx = ctx;
  hlNoteTextarea.value = ctx.note || '';
  renderHlPopoverSwatches(ctx.color);
  hlNoteRemoveBtn.textContent = ctx.mode === 'edit' ? 'Remover destaque' : 'Cancelar';
  hlNotePopover.hidden = false;
  positionFloating(hlNotePopover, anchorRect);
  hlNoteTextarea.focus();
}
function closeNoteEditor() {
  hlNotePopover.hidden = true;
  noteEditorCtx = null;
}

selectionNoteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!pendingSelection) return;
  openNoteEditor(
    { mode: 'new', pageNum: pendingSelection.pageNum, start: pendingSelection.start, end: pendingSelection.end, color: HL_PALETTE[0], note: '' },
    selectionToolbar.getBoundingClientRect()
  );
});

hlNotePopover.addEventListener('mousedown', (e) => {
  if (e.target !== hlNoteTextarea) e.preventDefault();
});
hlNoteSaveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!noteEditorCtx) return;
  const note = hlNoteTextarea.value.trim();
  const { mode, pageNum, color } = noteEditorCtx;
  if (mode === 'new') {
    createHighlight(pageNum, noteEditorCtx.start, noteEditorCtx.end, color, note || null);
    window.getSelection()?.removeAllRanges();
  } else {
    updateHighlight(pageNum, noteEditorCtx.id, { color, note: note || null });
  }
  closeNoteEditor();
  toast(note ? 'Nota salva.' : 'Destaque salvo.');
});
hlNoteRemoveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!noteEditorCtx) return;
  if (noteEditorCtx.mode === 'edit') {
    removeHighlight(noteEditorCtx.pageNum, noteEditorCtx.id);
    toast('Destaque removido.');
  }
  closeNoteEditor();
});

function openHighlightEditor(pageNum, hl, anchorRect) {
  openNoteEditor(
    { mode: 'edit', pageNum, id: hl.id, start: hl.start, end: hl.end, color: hl.color, note: hl.note || '' },
    anchorRect
  );
}

// Click an existing highlight (or its note marker) to review/edit/remove
// it — works in any tool, not just select, so notes stay reachable while
// panning. Outside the select tool the text layer has pointer-events:none,
// so a click lands directly on the highlight-layer's own .text-hl/marker.
pagesEl.addEventListener('click', (e) => {
  const target = e.target.closest('.hl-note-marker, .text-hl');
  if (target) {
    e.stopPropagation();
    const pageEl = target.closest('.page');
    const num = +pageEl.dataset.page;
    const hl = findHighlight(num, target.dataset.hlId);
    if (!hl) return;
    openHighlightEditor(num, hl, target.getBoundingClientRect());
    return;
  }

  // In the select tool the (topmost, span-scoped) text layer swallows the
  // click before it ever reaches the highlight layer beneath — without
  // this, a highlight with no note attached had no click target at all
  // while select was active, and "remove this highlight" was unreachable.
  // A plain tap (not a drag that just made a new selection) on marked text
  // routes here to that highlight's editor instead.
  if (state.tool !== 'select' || !document.caretRangeFromPoint) return;
  const span = e.target.closest('.text-layer span');
  if (!span) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return; // a real drag-selection — let it be
  const container = span.closest('.text-layer');
  const pageEl = container?.closest('.page');
  if (!pageEl) return;
  const caret = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!caret) return;
  const offs = offsetsFromRange(container, caret);
  if (!offs) return;
  const num = +pageEl.dataset.page;
  const hit = (state.textHighlights[num] || []).find((h) => offs.start >= h.start && offs.start < h.end);
  if (!hit) return;
  e.stopPropagation();
  openHighlightEditor(num, hit, span.getBoundingClientRect());
});

// ============================================================
// Action dispatch
// ============================================================
const ACTIONS = {
  open: openViaDialog,
  find: toggleFindBar,
  toolSelect: () => toggleTool('select'),
  toolPen: () => toggleTool('pen'),
  toolHighlighter: () => toggleTool('highlighter'),
  toolEraser: () => toggleTool('eraser'),
  toolPan: () => setTool('pan'),
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

  // Ctrl+Y is the other common "redo" convention (Windows-style, alongside
  // the configurable Ctrl+Shift+Z above) — always available as a fallback,
  // unless the user has deliberately rebound some other action onto it.
  if (combo === 'ctrl+y') {
    e.preventDefault();
    redo();
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
// Same for the note editor — the selection toolbar closes itself instead
// (selectionchange fires as soon as the click lands, before this handler
// runs, and its own handlers stopPropagation() so this never fights them).
document.addEventListener('click', (e) => {
  if (!hlNotePopover.hidden && !e.target.closest('#hl-note-popover')) closeNoteEditor();
});
// Repositioning a floating popover mid-scroll is more churn than it's
// worth — just close it, same as the theme popovers would if they could
// scroll away.
viewer.addEventListener('scroll', () => {
  hideSelectionToolbar();
  if (!hlNotePopover.hidden) closeNoteEditor();
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && spaceHeld) {
    spaceHeld = false;
    setTool(state.prevTool || 'pan');
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
    if (!findBar.hidden) positionFindBar();
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
setTool('pan');
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
