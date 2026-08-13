import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { loadPdfDocument } from './load-pdf-document.js';
import { getFontForLanguage, detectScripts } from './font-loader.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export interface TextItem {
  str: string;
  transform: number[]; // [a,b,c,d,e,f]
  width: number;
  height: number;
  fontName: string;
}

export interface TextEdit {
  pageIndex: number;
  original: string;
  edited: string;
  x: number; // PDF user space
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

const activeEdits = new Map<string, TextEdit>(); // key: pageIndex:itemIndex
let currentScale = 1.5;
let currentPdfBytes: Uint8Array | null = null;
let pdfDocProxy: pdfjsLib.PDFDocumentProxy | null = null;

function keyFor(p: number, i: number) {
  return `${p}:${i}`;
}

export function hasTextEdits(): boolean {
  for (const e of activeEdits.values())
    if (e.edited !== e.original) return true;
  return false;
}

export function getTextEdits(): TextEdit[] {
  return Array.from(activeEdits.values()).filter(
    (e) => e.edited !== e.original
  );
}

export function clearTextEdits() {
  activeEdits.clear();
}

function estimateFontSize(transform: number[]): number {
  // transform[0]=scalex, transform[1]=skewY; font size ~ hypot(a,b)
  return Math.hypot(transform[0], transform[1]);
}

export async function mountTextEditLayer(
  pdfBytes: Uint8Array,
  container: HTMLElement,
  scale = 1.5
): Promise<void> {
  currentScale = scale;
  currentPdfBytes = pdfBytes.slice();
  container.innerHTML = '';
  activeEdits.clear();

  // close previous doc
  try {
    await pdfDocProxy?.destroy();
  } catch {}
  const loading = pdfjsLib.getDocument({
    data: pdfBytes.slice(),
    wasmUrl: import.meta.env.BASE_URL + 'pdfjs-viewer/wasm/',
  });
  pdfDocProxy = await loading.promise;

  for (let p = 1; p <= pdfDocProxy.numPages; p++) {
    const page = await pdfDocProxy.getPage(p);
    const viewport = page.getViewport({ scale });
    const textContent = (await page.getTextContent()) as unknown as {
      items: TextItem[];
    };

    const pageWrapper = document.createElement('div');
    pageWrapper.className =
      'relative mx-auto mb-6 bg-white shadow-lg border border-gray-200 rounded-lg overflow-hidden';
    pageWrapper.style.width = viewport.width + 'px';
    pageWrapper.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    canvas.className = 'block';
    const ctx = canvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, canvas, viewport } as any).promise;

    const layer = document.createElement('div');
    layer.className = 'absolute inset-0 text-layer pointer-events-none';
    layer.style.width = viewport.width + 'px';
    layer.style.height = viewport.height + 'px';

    // For each text item create editable overlay
    textContent.items.forEach((item, idx) => {
      if (!item.str?.trim()) return;
      // viewport transform
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const x = tx[4];
      const y = tx[5];
      const fontSize = estimateFontSize(tx);
      // y is baseline; top = y - ascent approx
      const w = item.width * scale;
      const h = fontSize * 1.2;
      const left = x;
      const top = y - h + fontSize * 0.35;

      const el = document.createElement('div');
      el.contentEditable = 'true';
      el.spellcheck = false;
      el.textContent = item.str;
      el.dataset.pageIndex = String(p - 1);
      el.dataset.itemIndex = String(idx);
      el.dataset.original = item.str;
      el.dataset.x = String(item.transform[4]);
      el.dataset.y = String(item.transform[5]);
      el.dataset.width = String(item.width);
      el.dataset.height = String(item.height);
      el.dataset.fontSize = String(estimateFontSize(item.transform));
      el.className =
        'text-edit-item absolute pointer-events-auto outline-none whitespace-nowrap overflow-hidden leading-none bg-white/0 hover:bg-yellow-50/60 focus:bg-white focus:shadow-md focus:ring-2 focus:ring-indigo-400 border border-transparent hover:border-yellow-300 focus:border-indigo-400 rounded-[2px] px-0.5';
      el.style.left = left + 'px';
      el.style.top = Math.max(0, top) + 'px';
      el.style.fontSize = fontSize + 'px';
      el.style.width = Math.max(w + 6, 24) + 'px';
      el.style.height = h + 'px';
      el.style.lineHeight = h + 'px';
      el.style.fontFamily = 'Helvetica, Arial, sans-serif';
      el.style.color = 'transparent';
      el.style.caretColor = '#2c2f76';

      // show text via data attribute? easier: make color transparent until focus, show on hover via JS
      let isEditing = false;
      const show = () => {
        el.style.color = '#111827';
        el.style.backgroundColor = 'rgba(255,255,255,0.92)';
      };
      const hide = () => {
        if (isEditing) return;
        el.style.color = 'transparent';
        el.style.backgroundColor = 'transparent';
      };
      el.addEventListener('mouseenter', show);
      el.addEventListener('mouseleave', hide);
      el.addEventListener('focus', () => {
        isEditing = true;
        show();
        // select all
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
      el.addEventListener('blur', () => {
        isEditing = false;
        const edited = el.textContent || '';
        const pageIndex = p - 1;
        const k = keyFor(pageIndex, idx);
        const existing = activeEdits.get(k);
        if (existing) {
          existing.edited = edited;
        } else {
          activeEdits.set(k, {
            pageIndex,
            original: item.str,
            edited,
            x: item.transform[4],
            y: item.transform[5],
            width: item.width,
            height: item.height,
            fontSize: estimateFontSize(item.transform),
          });
        }
        // keep highlight if changed
        if (edited !== item.str) {
          el.style.color = '#111827';
          el.style.backgroundColor = 'rgba(254,243,199,0.85)';
          el.style.borderColor = '#f59e0b';
        } else {
          hide();
          el.style.borderColor = 'transparent';
        }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        }
        if (e.key === 'Escape') {
          el.textContent = el.dataset.original || '';
          (el as HTMLElement).blur();
        }
      });

      layer.appendChild(el);

      // prime edit map
      activeEdits.set(keyFor(p - 1, idx), {
        pageIndex: p - 1,
        original: item.str,
        edited: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height,
        fontSize: estimateFontSize(item.transform),
      });
    });

    pageWrapper.appendChild(canvas);
    pageWrapper.appendChild(layer);
    // page label
    const label = document.createElement('div');
    label.className =
      'absolute top-1 left-1 text-[10px] bg-gray-900/75 text-white px-1.5 py-0.5 rounded';
    label.textContent = `Page ${p}`;
    pageWrapper.appendChild(label);

    container.appendChild(pageWrapper);
  }
}

export function applyFindReplace(
  container: HTMLElement,
  find: string,
  replace: string,
  matchCase = false
) {
  if (!find) return 0;
  let count = 0;
  const flags = matchCase ? 'g' : 'gi';
  const re = new RegExp(escapeRegExp(find), flags as any);
  container.querySelectorAll<HTMLElement>('.text-edit-item').forEach((el) => {
    const orig = el.textContent || '';
    const next = orig.replace(re, replace);
    if (next !== orig) {
      el.textContent = next;
      el.dispatchEvent(new Event('blur'));
      count++;
    }
  });
  return count;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function buildEditedPdf(
  originalBytes: Uint8Array
): Promise<Uint8Array> {
  const edits = getTextEdits();
  if (edits.length === 0) return originalBytes;

  const pdfDoc = await loadPdfDocument(originalBytes);
  const pages = pdfDoc.getPages();

  // Group by page
  const byPage = new Map<number, TextEdit[]>();
  for (const e of edits) {
    if (!byPage.has(e.pageIndex)) byPage.set(e.pageIndex, []);
    byPage.get(e.pageIndex)!.push(e);
  }

  // Cache fonts per detected script to preserve CJK
  const fontCache = new Map<string, any>();

  async function getFontForText(text: string) {
    const scripts = detectScripts(text);
    const key = scripts.join(',') || 'eng';
    if (fontCache.has(key)) return fontCache.get(key);
    // For simplicity, prioritize first non-eng script, otherwise eng
    const lang = scripts.find((s) => s !== 'eng') || 'eng';
    try {
      if (lang !== 'eng') {
        const buf = await getFontForLanguage(lang);
        const font = await pdfDoc.embedFont(
          buf as any,
          { subset: true } as any
        );
        fontCache.set(key, font);
        return font;
      }
    } catch {}
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    fontCache.set(key, font);
    return font;
  }

  for (const [pageIndex, list] of byPage) {
    const page = pages[pageIndex];
    if (!page) continue;
    const { height: pageHeight } = page.getSize();

    for (const e of list) {
      // whiteout: pdf coords origin bottom-left, e.y is baseline from bottom
      // Use width/height from pdfjs; add small padding
      const pad = 1;
      const rectX = e.x - pad;
      const rectY = e.y - pad;
      const rectW = e.width + pad * 2;
      const rectH = e.height + pad * 2 || e.fontSize * 1.1;

      page.drawRectangle({
        x: rectX,
        y: rectY,
        width: rectW,
        height: rectH,
        color: rgb(1, 1, 1),
        borderWidth: 0,
        opacity: 1,
      });

      // Draw new text at same baseline
      const font = await getFontForText(e.edited);
      // Estimate width scaling: if edited longer than original, slightly reduce font size to fit
      let fontSize = e.fontSize;
      try {
        const origWidth = font.widthOfTextAtSize(e.original, fontSize);
        const newWidth = font.widthOfTextAtSize(e.edited, fontSize);
        if (newWidth > rectW && origWidth > 0) {
          fontSize = fontSize * (rectW / newWidth) * 0.98;
          fontSize = Math.max(6, fontSize);
        }
      } catch {}

      page.drawText(e.edited, {
        x: e.x,
        y: e.y,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
        lineHeight: e.fontSize,
      });
    }
    // Ensure page height flip is correct - pdf-lib uses bottom origin, we already used
    void pageHeight;
  }

  return new Uint8Array(await pdfDoc.save());
}
