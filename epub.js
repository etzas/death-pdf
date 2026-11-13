// EPUB -> PDF conversion.
//
// An EPUB is a ZIP of XHTML chapters + CSS + images. Instead of writing a
// second viewer, we extract it to a temp folder, stitch the chapters (in
// spine order) into one HTML page, and let Chromium print it to PDF. The
// resulting PDF goes through the normal pipeline, so every existing tool
// (pen, highlighter, search, themes, export) works on EPUBs for free.
// Results are cached by path + size + mtime so reopening is instant.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

// ---------------- minimal ZIP reader ----------------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EPUB invalido (zip nao reconhecido)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    entries.set(name, { method, raw });
  }
  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    get(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.method === 0) return Buffer.from(e.raw);
      if (e.method === 8) return zlib.inflateRawSync(e.raw);
      throw new Error('Compressao zip nao suportada: ' + e.method);
    },
  };
}

// ---------------- tiny XML helpers ----------------
function attrs(tag) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
  return out;
}
function tags(xml, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>`, 'gi');
  return (xml.match(re) || []).map(attrs);
}
function posixJoin(base, rel) {
  return path.posix.normalize(path.posix.join(base, rel));
}
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

// XHTML allows <div/>; the HTML parser would treat that as an open tag.
function expandSelfClosing(html) {
  return html.replace(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\/>/g, (all, tag, rest = '') =>
    VOID.has(tag.toLowerCase()) ? all : `<${tag}${rest}></${tag}>`);
}

// ---------------- conversion ----------------
async function buildHtml(zip, workDir) {
  const container = zip.get('META-INF/container.xml');
  if (!container) throw new Error('EPUB sem META-INF/container.xml');
  const rootfile = tags(container.toString('utf8'), 'rootfile')[0];
  if (!rootfile || !rootfile['full-path']) throw new Error('EPUB sem arquivo OPF');
  const opfPath = safeDecode(rootfile['full-path']);
  const opfDir = path.posix.dirname(opfPath);
  const opf = zip.get(opfPath).toString('utf8');

  const manifest = new Map();
  for (const it of tags(opf, 'item')) if (it.id) manifest.set(it.id, it);
  const spine = tags(opf, 'itemref')
    .map((r) => manifest.get(r.idref))
    .filter((it) => it && /html/i.test(it['media-type'] || 'html'));
  if (!spine.length) throw new Error('EPUB sem capitulos');

  // Extract everything (skipping unsafe paths) so images/CSS/fonts resolve.
  const root = path.resolve(workDir, 'book');
  for (const name of zip.names()) {
    const dest = path.resolve(root, name);
    if (!dest.startsWith(root + path.sep)) continue;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, zip.get(name));
  }

  const styles = [];
  const seenCss = new Set();
  const bodies = [];
  for (const item of spine) {
    const chapPath = posixJoin(opfDir, safeDecode(item.href));
    const buf = zip.get(chapPath);
    if (!buf) continue;
    const src = buf.toString('utf8');
    const chapDir = path.posix.dirname(chapPath);
    const absUrl = (rel) => {
      if (/^(?:[a-z]+:|#|\/\/)/i.test(rel)) return rel;
      const [p, hash] = rel.split('#');
      const file = path.resolve(root, posixJoin(chapDir, safeDecode(p)));
      return pathToFileURL(file).href + (hash ? '#' + hash : '');
    };

    const head = (src.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [])[1] || '';
    for (const l of head.match(/<link\b[^>]*>/gi) || []) {
      const a = attrs(l);
      if (!/stylesheet/i.test(a.rel || '') || !a.href) continue;
      const url = absUrl(a.href);
      if (!seenCss.has(url)) { seenCss.add(url); styles.push(`<link rel="stylesheet" href="${url}">`); }
    }
    for (const s of head.match(/<style\b[\s\S]*?<\/style>/gi) || []) styles.push(s);

    let body = (src.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1];
    if (body === undefined) body = src;
    body = body.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    body = body.replace(/((?:xlink:)?href|src)\s*=\s*("([^"]*)"|'([^']*)')/gi,
      (all, attr, _q, d, s) => `${attr}="${absUrl(d !== undefined ? d : s)}"`);
    bodies.push(`<section class="dpdf-chapter">${expandSelfClosing(body)}</section>`);
  }

  const title = ((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '').trim();
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
${styles.join('\n')}
<style>
  @page { size: A5; margin: 16mm 14mm; }
  html, body { background: #fff; color: #111; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.5; margin: 0; }
  .dpdf-chapter { break-before: page; }
  .dpdf-chapter:first-child { break-before: auto; }
  img, svg, video { max-width: 100% !important; max-height: 175mm; height: auto; object-fit: contain; }
  pre { white-space: pre-wrap; }
  a { color: inherit; }
</style></head><body>${bodies.join('\n')}</body></html>`;
  const htmlPath = path.join(root, '__deathpdf_book.html');
  await fs.writeFile(htmlPath, html, 'utf8');
  return htmlPath;
}

async function renderToPdf(htmlPath) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true },
  });
  try {
    await win.loadFile(htmlPath);
    return await win.webContents.printToPDF({ pageSize: 'A5', printBackground: true, preferCSSPageSize: true });
  } finally {
    win.destroy();
  }
}

async function epubToPdf(epubPath) {
  const stat = await fs.stat(epubPath);
  const key = crypto.createHash('sha256')
    .update(path.resolve(epubPath) + '|' + stat.size + '|' + stat.mtimeMs).digest('hex');
  const cacheDir = path.join(app.getPath('userData'), 'epub-cache');
  const cached = path.join(cacheDir, key + '.pdf');
  try { return await fs.readFile(cached); } catch { /* convert below */ }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deathpdf-epub-'));
  try {
    const zip = readZip(await fs.readFile(epubPath));
    const htmlPath = await buildHtml(zip, workDir);
    const pdf = await renderToPdf(htmlPath);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cached, pdf).catch(() => {});
    return pdf;
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { epubToPdf };
