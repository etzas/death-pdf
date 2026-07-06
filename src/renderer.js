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
  tool: 'select',
  prevTool: 'select',
  darkMode: false,
  penColor: '#ececec',
  penWidth: 3,
  hlColor: '#f5c518',
  hlWidth: 18,
  eraserWidth: 22,
  annotations: {}, // { [pageNum]: [stroke] }
  undoStack: [],
  redoStack: [],
};

const PEN_PALETTE = ['#ececec', '#c8102e', '#f5c518', '#38bdf8', '#4ade80'];
const HL_PALETTE = ['#f5c518', '#c8102e', '#4ade80', '#38bdf8', '#a78bfa'];
const MAX_UNDO = 80;

// ============================================================
// Shortcuts
// ============================================================
const DEFAULT_SHORTCUTS = {
  open: 'ctrl+o',
  toolSelect: 'v',
  toolPen: 'p',
  toolHighlighter: 'h',
  toolEraser: 'e',
  darkMode: 'ctrl+shift+d',
  undo: 'ctrl+z',
  redo: 'ctrl+shift+z',
  zoomIn: 'ctrl+=',
  zoomOut: 'ctrl+-',
  fitWidth: 'ctrl+0',
  nextPage: 'pagedown',
  prevPage: 'pageup',
  export: 'ctrl+e',
  settings: 'ctrl+,',
  clearPage: 'ctrl+shift+backspace',
};

const ACTION_LABELS = {
  open: 'Abrir PDF',
  toolSelect: 'Ferramenta: selecionar',
  toolPen: 'Ferramenta: caneta',
  toolHighlighter: 'Ferramenta: marca-texto',
  toolEraser: 'Ferramenta: borracha',
  darkMode: 'Modo escuro do PDF',
  undo: 'Desfazer',
  redo: 'Refazer',
  zoomIn: 'Aumentar zoom',
  zoomOut: 'Diminuir zoom',
  fitWidth: 'Ajustar a largura',
  nextPage: 'Proxima pagina',
  prevPage: 'Pagina anterior',
  export: 'Exportar PDF anotado',
  settings: 'Abrir preferencias',
  clearPage: 'Limpar anotacoes da pagina',
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
const statusEl = document.getElementById('status');

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
  if (res) await loadPdf(res);
}

async function loadPdf({ bytes, path, name }) {
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
    const saved = await window.dpdf.loadAnnotations(path);
    if (saved && saved.annotations) {
      state.annotations = saved.annotations;
      if (typeof saved.darkMode === 'boolean') setDarkMode(saved.darkMode);
    }

    emptyState.classList.add('hidden');
    document.title = `${name} — Death PDF`;

    fitWidth(); // sets scale and builds pages
    toast(`${name} — ${state.numPages} paginas`);
  } catch (err) {
    console.error(err);
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
    const dim = state.pageDims[i - 1];
    const w = dim.w * state.scale;
    const h = dim.h * state.scale;

    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.dataset.page = String(i);
    pageEl.dataset.rendered = 'false';
    pageEl.style.width = w + 'px';
    pageEl.style.height = h + 'px';

    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.className = 'pdf-layer';
    const annoCanvas = document.createElement('canvas');
    annoCanvas.className = 'anno-layer';

    pageEl.appendChild(pdfCanvas);
    pageEl.appendChild(annoCanvas);
    pagesEl.appendChild(pageEl);

    attachDrawingHandlers(pageEl, annoCanvas);
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
}

async function renderPage(pageEl) {
  if (pageEl.dataset.rendered === 'true' || pageEl._rendering) return;
  pageEl._rendering = true;
  const num = +pageEl.dataset.page;
  try {
    const page = await state.pdf.getPage(num);
    const viewport = page.getViewport({ scale: state.scale });
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
  } catch (err) {
    if (err && err.name !== 'RenderingCancelledException') console.error(err);
  } finally {
    pageEl._rendering = false;
  }
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
function annoCtxFor(pageEl) {
  const c = pageEl.querySelector('.anno-layer');
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

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
  for (const stroke of strokes) drawStroke(ctx, stroke, w, h);
}

function drawStroke(ctx, stroke, vw, vh) {
  const pts = stroke.points;
  if (!pts.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color;

  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = 0.32;
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * vw, pts[0][1] * vh);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0] * vw, pts[i][1] * vh);
    }
    if (pts.length === 1) ctx.lineTo(pts[0][0] * vw + 0.1, pts[0][1] * vh);
    ctx.stroke();
  } else {
    // Pen: variable width per segment based on pressure.
    ctx.globalAlpha = 1;
    if (pts.length === 1) {
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.arc(pts[0][0] * vw, pts[0][1] * vh, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const pAvg = (a[2] + b[2]) / 2;
        ctx.lineWidth = stroke.width * pressureScale(stroke, pAvg);
        ctx.beginPath();
        ctx.moveTo(a[0] * vw, a[1] * vh);
        ctx.lineTo(b[0] * vw, b[1] * vh);
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
// Drawing input (pen / highlighter / eraser)
// ============================================================
function attachDrawingHandlers(pageEl, canvas) {
  let active = null; // current stroke while drawing
  let erasing = false;
  let beforeSnapshot = null;

  const relPoint = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    const { w, h } = pageCssSize(pageEl);
    return [(clientX - r.left) / w, (clientY - r.top) / h];
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!['pen', 'highlighter', 'eraser'].includes(state.tool)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const num = +pageEl.dataset.page;
    beforeSnapshot = clone(state.annotations[num] || []);

    if (state.tool === 'eraser') {
      erasing = true;
      eraseAt(pageEl, e.clientX, e.clientY, relPoint);
      return;
    }

    const isPen = e.pointerType === 'pen';
    const [x, y] = relPoint(e.clientX, e.clientY);
    active = {
      tool: state.tool,
      color: state.tool === 'pen' ? state.penColor : state.hlColor,
      width: state.tool === 'pen' ? state.penWidth : state.hlWidth,
      pen: isPen,
      points: [[x, y, isPen ? e.pressure || 0.5 : 0.5]],
    };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (erasing) {
      eraseAt(pageEl, e.clientX, e.clientY, relPoint);
      return;
    }
    if (!active) return;
    e.preventDefault();
    // Coalesced events give every sample the tablet produced between
    // frames — this is what makes lines faithful and precise.
    const events =
      typeof e.getCoalescedEvents === 'function'
        ? e.getCoalescedEvents()
        : [e];
    const ctx = annoCtxFor(pageEl);
    const { w, h } = pageCssSize(pageEl);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = active.color;
    ctx.globalAlpha = active.tool === 'highlighter' ? 0.32 : 1;
    for (const ev of events.length ? events : [e]) {
      const [x, y] = relPoint(ev.clientX, ev.clientY);
      const pr = active.pen ? ev.pressure || 0.5 : 0.5;
      const prev = active.points[active.points.length - 1];
      active.points.push([x, y, pr]);
      if (active.tool === 'highlighter') ctx.lineWidth = active.width;
      else ctx.lineWidth = active.width * pressureScale(active, (prev[2] + pr) / 2);
      ctx.beginPath();
      ctx.moveTo(prev[0] * w, prev[1] * h);
      ctx.lineTo(x * w, y * h);
      ctx.stroke();
    }
    ctx.restore();
  });

  const finish = (num) => {
    if (active && active.points.length) {
      (state.annotations[num] ||= []).push(active);
      pushUndo(num, beforeSnapshot);
      redrawAnnotations(pageEl); // clean composited redraw (fixes highlighter overlap)
      scheduleSave();
    } else if (erasing) {
      pushUndo(num, beforeSnapshot);
      scheduleSave();
    }
    active = null;
    erasing = false;
    beforeSnapshot = null;
  };

  canvas.addEventListener('pointerup', () => finish(+pageEl.dataset.page));
  canvas.addEventListener('pointercancel', () => finish(+pageEl.dataset.page));
}

function eraseAt(pageEl, clientX, clientY, relPoint) {
  const num = +pageEl.dataset.page;
  const strokes = state.annotations[num];
  if (!strokes || !strokes.length) return;
  const [px, py] = relPoint(clientX, clientY);
  const { w, h } = pageCssSize(pageEl);
  const rNormX = state.eraserWidth / w / 2;
  const rNormY = state.eraserWidth / h / 2;
  const before = strokes.length;
  state.annotations[num] = strokes.filter((s) => {
    return !s.points.some((pt) => {
      const dx = (pt[0] - px) / rNormX;
      const dy = (pt[1] - py) / rNormY;
      return dx * dx + dy * dy <= 1;
    });
  });
  if (state.annotations[num].length !== before) redrawAnnotations(pageEl);
}

// ============================================================
// Undo / redo
// ============================================================
function clone(x) {
  return JSON.parse(JSON.stringify(x));
}
function pushUndo(pageNum, beforeStrokes) {
  state.undoStack.push({ pageNum, strokes: beforeStrokes });
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack = [];
}
function undo() {
  const op = state.undoStack.pop();
  if (!op) return;
  state.redoStack.push({
    pageNum: op.pageNum,
    strokes: clone(state.annotations[op.pageNum] || []),
  });
  state.annotations[op.pageNum] = clone(op.strokes);
  redrawPage(op.pageNum);
  scheduleSave();
}
function redo() {
  const op = state.redoStack.pop();
  if (!op) return;
  state.undoStack.push({
    pageNum: op.pageNum,
    strokes: clone(state.annotations[op.pageNum] || []),
  });
  state.annotations[op.pageNum] = clone(op.strokes);
  redrawPage(op.pageNum);
  scheduleSave();
}
function redrawPage(num) {
  const el = pagesEl.querySelector(`.page[data-page="${num}"]`);
  if (el && el.dataset.rendered === 'true') redrawAnnotations(el);
}
function clearCurrentPage() {
  const num = getCurrentPage();
  const before = clone(state.annotations[num] || []);
  if (!before.length) return;
  pushUndo(num, before);
  state.annotations[num] = [];
  redrawPage(num);
  scheduleSave();
  toast(`Anotacoes da pagina ${num} removidas`);
}

// ============================================================
// Save (debounced sidecar autosave)
// ============================================================
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 600);
}
async function doSave() {
  if (!state.pdfPath) return;
  await window.dpdf.saveAnnotations(state.pdfPath, {
    version: 1,
    darkMode: state.darkMode,
    annotations: state.annotations,
  });
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
    const dim = state.pageDims[+pageEl.dataset.page - 1];
    pageEl.style.width = dim.w * newScale + 'px';
    pageEl.style.height = dim.h * newScale + 'px';
    clearPageCanvas(pageEl);
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
  const dim = state.pageDims[getCurrentPage() - 1] || state.pageDims[0];
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
// Dark mode
// ============================================================
function setDarkMode(on) {
  state.darkMode = on;
  viewer.classList.toggle('dark', on);
  darkBtn.classList.toggle('on', on);
  scheduleSave();
}
function toggleDarkMode() { setDarkMode(!state.darkMode); }

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
    const { PDFDocument, rgb, LineCapStyle } = window.PDFLib;
    const doc = await PDFDocument.load(state.pdfBytes);
    const pages = doc.getPages();

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
  toolPen: () => setTool('pen'),
  toolHighlighter: () => setTool('highlighter'),
  toolEraser: () => setTool('eraser'),
  darkMode: toggleDarkMode,
  undo,
  redo,
  zoomIn,
  zoomOut,
  fitWidth,
  nextPage: () => goToPage(getCurrentPage() + 1),
  prevPage: () => goToPage(getCurrentPage() - 1),
  export: exportPdf,
  settings: openSettings,
  clearPage: clearCurrentPage,
};

// Toolbar buttons
document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => ACTIONS[btn.dataset.action]?.());
});
document.querySelectorAll('#tool-group .tool').forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
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
  const action = Object.keys(shortcuts).find((a) => shortcuts[a] === combo);
  if (action && ACTIONS[action]) {
    e.preventDefault();
    ACTIONS[action]();
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
  window._rz = setTimeout(() => state.pdf && renderVisible(), 200);
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
setTool('select');
updateHints();
window.dpdf.onOpenFilePath(async (p) => {
  const res = await window.dpdf.readPdf(p);
  if (res) await loadPdf(res);
});
