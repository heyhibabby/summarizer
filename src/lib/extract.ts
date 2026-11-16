import { buildChapters, chaptersFromText, type Chapter, type Line, type OutlineEntry } from "./chapters";
import { countWords, normalizeExtracted } from "./text";
import { findReviewFindings, type Finding, type SourceKind, type SourceRecord } from "./summarizer";

export const MAX_SOURCES = 5;
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 600_000;
export const MAX_PDF_PAGES = 900;
export const ACCEPTED_FILES = ".pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

export type Progress = (label: string) => void;

export type Structure = { chapters: Chapter[]; method: NonNullable<SourceRecord["chapterMethod"]>; layout?: { lines: Line[]; outline: OutlineEntry[] } };

export function makeSource(name: string, kind: SourceKind, text: string, note?: string, extraFindings: Finding[] = [], structure?: Structure | null, file?: File): SourceRecord {
  const trimmed = text.length > MAX_EXTRACTED_CHARS ? text.slice(0, MAX_EXTRACTED_CHARS) : text;
  const truncated = trimmed.length < text.length ? `Only the first ${MAX_EXTRACTED_CHARS.toLocaleString()} characters were read.` : "";
  // PDFs bring page-aware findings of their own; running the plain-text detector too would list every caption twice.
  // "see Table 7-35" style mentions are noise: only real captions, tables and images are worth listing.
  const findings = [...(kind === "PDF" ? [] : findReviewFindings(trimmed)), ...extraFindings].filter((f) => !/mention$/i.test(f.label)).map((finding, index) => ({ ...finding, id: `${finding.kind}-${index}` }));
  const joined = [note, truncated].filter(Boolean).join(" ");
  let found = structure ?? null;
  if (found === null && structure === undefined && (kind === "Text" || kind === "Markdown" || kind === "Pasted text" || kind === "Word")) {
    const detected = chaptersFromText(trimmed);
    if (detected.chapters.length >= 2 && (detected.method !== "parts" || countWords(trimmed) >= 6000)) found = detected;
  }
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    kind,
    text: trimmed,
    status: "ready",
    ...(joined ? { note: joined } : {}),
    findings,
    ...(found && found.chapters.length >= 2 ? { chapters: found.chapters, chapterMethod: found.method, ...(found.layout ? { layout: found.layout } : { layout: { lines: trimmed.split("\n").map((t) => ({ text: t })), outline: [] } }) } : {}),
    ...(file ? { file } : {}),
  };
}

const fileKind = (file: File): "pdf" | "docx" | "md" | "txt" | null => {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || file.type === "application/pdf") return "pdf";
  if (ext === "docx" || file.type.includes("wordprocessingml")) return "docx";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "txt" || file.type.startsWith("text/")) return "txt";
  return null;
};

export class ExtractError extends Error {}

/* ------------------------------------------------------------------------------------------ */

type PdfTextItem = { str: string; hasEOL?: boolean; transform: number[]; height?: number };
/* eslint-disable @typescript-eslint/no-explicit-any */
type PdfDoc = any;
type PdfLib = any;

const PAGE_NUMBER = /^\s*[-–—]?\s*(?:page\s*)?(?:\d{1,4}|[ivxlc]{1,6})\s*[-–—]?\s*$/i;
const TOC_LINE = /\.{3,}\s*\d{1,4}\s*$|[\p{L})\].,]\s+\d{1,4}\s*$|\d+(?:,\s*\d+)+\s*$/u;
const FIGURE_CAPTION = /\b(?:figure|fig\.|chart|graph|image|photo|illustration|diagram|plate)\s*[\dIVX]/i;

async function resolveOutline(doc: PdfDoc): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = [];
  try {
    const tree = await doc.getOutline();
    if (!tree) return out;
    const walk = async (items: any[], level: number) => {
      for (const item of items) {
        if (out.length > 600) return;
        try {
          let dest = item.dest;
          if (typeof dest === "string") dest = await doc.getDestination(dest);
          const ref = Array.isArray(dest) ? dest[0] : null;
          if (ref !== null && ref !== undefined) {
            const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref);
            out.push({ title: String(item.title ?? "").trim(), page: index + 1, level });
          }
        } catch {
          /* unresolved bookmark: skip */
        }
        if (level < 2 && item.items?.length) await walk(item.items, level + 1);
      }
    };
    await walk(tree, 0);
  } catch {
    /* no outline */
  }
  return out.filter((o) => o.title);
}

/** Read a loaded PDF into cleaned lines, chapters and visual findings. Exported for tests. */
export async function analyzePdf(pdfjs: PdfLib, doc: PdfDoc, fileName: string, signal: AbortSignal, progress: Progress) {
  const limit = Math.min(doc.numPages, MAX_PDF_PAGES);
  const pageLines: Line[][] = [];
  const imageFindings: Finding[] = [];
  const imageOps = new Set<number>([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject].filter((op: unknown): op is number => typeof op === "number"));

  for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    if (pageNumber % 3 === 1) progress(`Reading ${fileName} · page ${pageNumber} of ${limit}`);
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines: Line[] = [];
    let line = "";
    let lineSize = 0;
    let lastY: number | null = null;
    let lastHeight = 10;
    const push = () => {
      if (line.trim()) lines.push({ text: line.trim(), page: pageNumber, size: lineSize });
      line = "";
      lineSize = 0;
    };
    for (const raw of content.items as unknown[]) {
      if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
      const item = raw as PdfTextItem;
      const y = item.transform[5] ?? 0;
      const height = item.height || Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || lastHeight;
      if (lastY !== null && Math.abs(y - lastY) > height * 1.9 && line.trim()) {
        push();
        lines.push({ text: "", page: pageNumber });
      } else if (lastY !== null && Math.abs(y - lastY) > height * 0.6 && !item.hasEOL && line.trim() && item.str.trim()) {
        push(); // baseline moved without an explicit EOL: a new line
      }
      line += item.str;
      if (item.str.trim()) lineSize = Math.max(lineSize, height);
      if (item.hasEOL) push();
      lastY = y;
      lastHeight = height;
    }
    push();
    pageLines.push(lines);

    // Image detection is the slow part: only look where a picture is plausible.
    const pageWords = lines.reduce((sum, l) => sum + countWords(l.text), 0);
    if (pageWords < 140 || lines.some((l) => FIGURE_CAPTION.test(l.text))) {
      try {
        const ops = await page.getOperatorList();
        const count = (ops.fnArray as number[]).filter((fn) => imageOps.has(fn)).length;
        if (count > 0) imageFindings.push({ id: "", kind: "image", label: "Embedded image", excerpt: `Page ${pageNumber}: ${count} embedded image${count === 1 ? "" : "s"}`, included: true, remove: "", page: pageNumber });
      } catch {
        /* best effort */
      }
    }
    page.cleanup();
  }
  const outline = await resolveOutline(doc);
  await doc.cleanup();

  // Drop pages that are a table of contents / index.
  const total = pageLines.length;
  const skipped = new Set<number>();
  pageLines.forEach((lines, i) => {
    const real = lines.filter((l) => l.text.trim());
    if (real.length < 8) return;
    const edge = i <= total * 0.15 || i >= total * 0.8;
    const tocLike = real.filter((l) => TOC_LINE.test(l.text) && countWords(l.text) <= 16).length / real.length;
    if (edge && tocLike >= 0.5) skipped.add(i);
  });

  // Running headers/footers and bare page numbers.
  const freq = new Map<string, number>();
  pageLines.forEach((lines, i) => {
    if (skipped.has(i)) return;
    for (const key of new Set(lines.filter((l) => l.text.trim()).map((l) => l.text.replace(/\d+/g, "#").toLowerCase()))) freq.set(key, (freq.get(key) ?? 0) + 1);
  });
  const repeats = total >= 4 ? total * 0.35 : Number.POSITIVE_INFINITY;
  const lines: Line[] = [];
  pageLines.forEach((pl, i) => {
    if (skipped.has(i)) return;
    for (const l of pl) {
      if (l.text) {
        if (PAGE_NUMBER.test(l.text)) continue;
        if (l.text.length < 90 && !/^(?:table|tbl\.?|figure|fig\.?|chart|graph|exhibit)\s*[\dIVX]/i.test(l.text) && (freq.get(l.text.replace(/\d+/g, "#").toLowerCase()) ?? 0) >= repeats) continue;
        const normalized = normalizeExtracted(l.text);
        if (normalized.includes("\n\n")) {
          normalized.split(/\n\n/).forEach((part, k) => {
            if (k) lines.push({ text: "", ...(l.page ? { page: l.page } : {}) });
            if (part.trim()) lines.push({ ...l, text: part.trim() });
          });
          continue;
        }
        lines.push({ ...l, text: normalized.trim() });
      } else lines.push(l);
    }
  });

  const dehyphenate = (t: string) => t.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2").replace(/\n{3,}/g, "\n\n");
  const text = dehyphenate(lines.map((l) => l.text).join("\n"));
  const built = buildChapters(lines, outline);
  const chapters = built.chapters.map((c) => ({ ...c, text: dehyphenate(c.text) }));

  // Captions / tables found per page so every finding knows its page (and therefore its chapter).
  const textFindings: Finding[] = [];
  const seen = new Set<string>();
  const byPage = new Map<number, string[]>();
  for (const l of lines) if (l.page) byPage.set(l.page, [...(byPage.get(l.page) ?? []), l.text]);
  for (const [pageNumber, texts] of byPage) {
    for (const f of findReviewFindings(texts.join("\n"))) {
      const key = `${f.kind}:${f.excerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      textFindings.push({ ...f, page: pageNumber });
    }
  }
  return { text, chapters, method: built.method, layout: { lines, outline }, findings: [...textFindings, ...imageFindings.slice(0, 80)], numPages: doc.numPages, read: limit, skippedPages: skipped.size };
}

async function extractPdf(file: File, signal: AbortSignal, progress: Progress): Promise<SourceRecord> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await pdfjs.getDocument({ data }).promise;
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "PasswordException") throw new ExtractError(`${file.name}: this PDF is password-protected. Remove the password and add it again.`);
    throw new ExtractError(`${file.name}: this PDF could not be opened (${error instanceof Error ? error.message : "unknown error"}).`);
  }
  const result = await analyzePdf(pdfjs, doc, file.name, signal, progress);
  if (countWords(result.text) < 20) throw new ExtractError(`${file.name}: little or no selectable text. This looks like a scanned or image-only PDF — run OCR on it or paste its text instead.`);
  const how = { bookmarks: "from the PDF’s bookmarks", font: "from heading sizes", headings: "from chapter headings", captions: "from table/figure numbers", parts: "as equal page ranges (no clear headings found)" }[result.method];
  const bits = [
    result.numPages > result.read ? `Read the first ${result.read} of ${result.numPages} pages.` : "",
    result.chapters.length >= 2 ? `${result.chapters.length} sections detected ${how}.` : "",
    result.skippedPages ? `${result.skippedPages} contents/index page${result.skippedPages === 1 ? "" : "s"} skipped.` : "",
  ].filter(Boolean);
  const structure: Structure | null = result.chapters.length >= 2 ? { chapters: result.chapters, method: result.method, layout: result.layout } : null;
  return makeSource(file.name, "PDF", result.text, bits.join(" "), result.findings.map((f) => ({ ...f })), structure, file);
}

async function extractDocx(file: File): Promise<SourceRecord> {
  const mammoth = (await import("mammoth/mammoth.browser")) as unknown as { convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const doc = new DOMParser().parseFromString(value, "text/html");
  const out: string[] = [];
  doc.body.querySelectorAll("h1,h2,h3,p,li,tr").forEach((node) => {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const tag = node.tagName.toLowerCase();
    if (tag === "h1" || tag === "h2") out.push("", `# ${text}`, "");
    else if (tag === "h3") out.push("", text, "");
    else if (tag === "tr") out.push([...node.querySelectorAll("td,th")].map((c) => (c.textContent ?? "").trim()).join(" | "));
    else out.push(text, "");
  });
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (countWords(text) < 5) throw new ExtractError(`${file.name}: no readable text found in this Word file.`);
  return makeSource(file.name, "Word", text, "Headings become sections. Images and charts inside the document are not read.");
}

/** Read files on-device. Returns what could be read, plus a message per file that could not. */
export async function readFiles(files: File[], signal: AbortSignal, progress: Progress): Promise<{ sources: SourceRecord[]; failures: string[] }> {
  const sources: SourceRecord[] = [];
  const failures: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    progress(`Reading ${index + 1} of ${files.length} · ${file.name}`);
    try {
      if (file.size > MAX_FILE_BYTES) throw new ExtractError(`${file.name}: larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB per-file limit.`);
      const kind = fileKind(file);
      if (kind === "pdf") sources.push(await extractPdf(file, signal, progress));
      else if (kind === "docx") sources.push(await extractDocx(file));
      else if (kind === "md" || kind === "txt") {
        const text = await file.text();
        if (!text.trim()) throw new ExtractError(`${file.name}: no readable text found.`);
        sources.push(makeSource(file.name, kind === "md" ? "Markdown" : "Text", text));
      } else throw new ExtractError(`${file.name}: unsupported type. Use PDF, Word (.docx), text or Markdown.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      failures.push(error instanceof ExtractError ? error.message : `${file.name}: could not be read (${error instanceof Error ? error.message : "unknown error"}).`);
    }
  }
  return { sources, failures };
}

/* ------------------------------------------------------------------------------------------ */
/* Articles                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Pick the container holding the most paragraph text — a light "readability" heuristic. */
export function extractMainText(doc: Document): { title: string; text: string } {
  doc.querySelectorAll("script,style,noscript,nav,footer,header,aside,form,iframe,svg,button,[role=navigation],[aria-hidden=true]").forEach((node) => node.remove());
  const title = doc.querySelector('meta[property="og:title"]')?.getAttribute("content") || doc.title || "";
  const scores = new Map<Element, { length: number; paragraphs: string[] }>();
  doc.querySelectorAll("p, li, h2, h3, blockquote").forEach((node) => {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 25) return;
    const parent = node.parentElement;
    if (!parent) return;
    const entry = scores.get(parent) ?? { length: 0, paragraphs: [] };
    entry.length += text.length;
    entry.paragraphs.push(text);
    scores.set(parent, entry);
  });
  let best: { length: number; paragraphs: string[] } | undefined;
  for (const entry of scores.values()) if (!best || entry.length > best.length) best = entry;
  const article = doc.querySelector("article");
  const articleText = article ? [...article.querySelectorAll("p")].map((p) => (p.textContent ?? "").replace(/\s+/g, " ").trim()).filter((t) => t.length > 25) : [];
  const paragraphs = articleText.join(" ").length >= (best?.length ?? 0) * 0.6 && articleText.length ? articleText : (best?.paragraphs ?? []);
  const text = paragraphs.join("\n\n") || (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
  return { title: title.trim(), text };
}

export async function fetchArticle(rawUrl: string, signal: AbortSignal, viaReader: boolean): Promise<SourceRecord> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new ExtractError("That does not look like a web address. Include https:// at the start.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ExtractError("Use an http or https address.");

  let title = "";
  let text = "";
  if (viaReader) {
    const response = await fetch(`https://r.jina.ai/${url.toString()}`, { signal, headers: { Accept: "text/plain" } });
    if (!response.ok) throw new ExtractError(`The reader service returned ${response.status}. Paste the article text instead.`);
    const body = await response.text();
    title = /^Title:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
    text = body.replace(/^(?:Title|URL Source|Published Time|Markdown Content):.*$/gm, "").trim();
  } else {
    const response = await fetch(url.toString(), { signal });
    if (!response.ok) throw new ExtractError(`The site returned ${response.status}. Paste the article text instead.`);
    const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
    ({ title, text } = extractMainText(parsed));
  }
  if (countWords(text) < 80) throw new ExtractError("Too little readable article text was found. Paste the article into the text box instead.");
  return makeSource(title || url.hostname, "Article", text, viaReader ? "Fetched through the reader service you opted into. Images and charts are not read." : "Images, tables and charts on the page are not read.");
}
