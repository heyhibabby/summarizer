import type { Chapter } from "./chapters";
import type { SourceRecord } from "./summarizer";

export type Visual = {
  kind: "table" | "figure" | "image";
  caption: string;
  page?: number;
  /** JPEG data URL of the PDF page that holds this visual (filled in after summarizing). */
  image?: string;
  width?: number;
  height?: number;
};

const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/** Tables / charts / images that belong to one chapter, in page order. Pure text + page logic — no rendering. */
export function chapterVisuals(source: Pick<SourceRecord, "findings" | "kind">, chapter: Chapter, taken: Set<string>, max = 5): Visual[] {
  const text = norm(chapter.text);
  const inPages = (page?: number) => page !== undefined && chapter.startPage !== undefined && chapter.endPage !== undefined && page >= chapter.startPage && page <= chapter.endPage;
  const mine = source.findings.filter((f) => {
    if (!f.included || /mention$/i.test(f.label) || taken.has(f.id)) return false;
    if (f.remove) return text.includes(norm(f.remove).slice(0, 80)) && (f.page === undefined || inPages(f.page) || chapter.startPage === undefined);
    return inPages(f.page); // image findings carry only a page
  });
  const captioned = mine.filter((f) => f.remove);
  const captionPages = new Set(captioned.map((f) => f.page).filter((p): p is number => p !== undefined));
  const bare = mine.filter((f) => !f.remove && !(f.page !== undefined && captionPages.has(f.page)));
  const visuals: (Visual & { id: string })[] = [
    ...captioned.map((f) => ({ id: f.id, kind: (f.kind === "table" ? "table" : f.kind === "chart" ? "figure" : "image") as Visual["kind"], caption: f.excerpt, ...(f.page !== undefined ? { page: f.page } : {}) })),
    ...bare.map((f) => ({ id: f.id, kind: "image" as const, caption: f.page !== undefined ? `Image on page ${f.page}` : f.excerpt, ...(f.page !== undefined ? { page: f.page } : {}) })),
  ].sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  const picked = visuals.slice(0, max);
  for (const v of picked) taken.add(v.id);
  return picked.map(({ id: _id, ...v }) => v);
}

/* ---- PDF page snapshots ---------------------------------------------------------------- */

type PdfDocPromise = Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const docs = new WeakMap<File, PdfDocPromise>();

async function openDoc(file: File): PdfDocPromise {
  let existing = docs.get(file);
  if (!existing) {
    existing = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    })();
    docs.set(file, existing);
  }
  return existing;
}

export async function renderPdfPage(file: File, pageNumber: number, maxWidth = 760): Promise<{ image: string; width: number; height: number } | null> {
  try {
    const doc = await openDoc(file);
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, maxWidth / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    page.cleanup();
    const image = canvas.toDataURL("image/jpeg", 0.72);
    canvas.width = canvas.height = 0; // release memory on iOS
    return { image, width: viewport.width, height: viewport.height };
  } catch {
    return null;
  }
}
