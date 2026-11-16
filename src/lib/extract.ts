import { countWords } from "./text";
import { findReviewFindings, type Finding, type SourceKind, type SourceRecord } from "./summarizer";

export const MAX_SOURCES = 5;
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 600_000;
export const MAX_PDF_PAGES = 300;
export const ACCEPTED_FILES = ".pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown";

export type Progress = (label: string) => void;

export function makeSource(name: string, kind: SourceKind, text: string, note?: string, extraFindings: Finding[] = []): SourceRecord {
  const trimmed = text.length > MAX_EXTRACTED_CHARS ? text.slice(0, MAX_EXTRACTED_CHARS) : text;
  const truncated = trimmed.length < text.length ? `Only the first ${MAX_EXTRACTED_CHARS.toLocaleString()} characters were read.` : "";
  const findings = [...findReviewFindings(trimmed), ...extraFindings].map((finding, index) => ({ ...finding, id: `${finding.kind}-${index}` }));
  const joined = [note, truncated].filter(Boolean).join(" ");
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    kind,
    text: trimmed,
    status: "ready",
    ...(joined ? { note: joined } : {}),
    findings,
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
  const limit = Math.min(doc.numPages, MAX_PDF_PAGES);
  const pages: string[][] = [];
  const imageFindings: Finding[] = [];
  const imageOps = new Set<number>([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject].filter((op): op is number => typeof op === "number"));

  for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    progress(`Reading ${file.name} · page ${pageNumber} of ${limit}`);
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines: string[] = [];
    let line = "";
    let lastY: number | null = null;
    let lastHeight = 10;
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const item = raw as unknown as PdfTextItem;
      const y = item.transform[5] ?? 0;
      const height = item.height || lastHeight;
      if (lastY !== null && Math.abs(y - lastY) > height * 1.9 && line.trim()) {
        lines.push(line.trim(), ""); // paragraph gap
        line = "";
      }
      line += item.str;
      if (item.hasEOL) {
        if (line.trim()) lines.push(line.trim());
        line = "";
      }
      lastY = y;
      lastHeight = height;
    }
    if (line.trim()) lines.push(line.trim());
    pages.push(lines);

    try {
      const ops = await page.getOperatorList();
      const count = ops.fnArray.filter((fn) => imageOps.has(fn)).length;
      if (count > 0) {
        imageFindings.push({ id: "", kind: "image", label: "Embedded image", excerpt: `Page ${pageNumber}: ${count} embedded image${count === 1 ? "" : "s"} (not readable as text)`, included: true, remove: "", page: pageNumber });
      }
    } catch {
      /* image detection is best effort */
    }
    page.cleanup();
  }
  await doc.cleanup();

  // Drop running headers/footers/page numbers that repeat on many pages.
  let cleaned = pages;
  if (pages.length >= 4) {
    const freq = new Map<string, number>();
    for (const lines of pages) for (const key of new Set(lines.filter(Boolean).map((l) => l.replace(/\d+/g, "#").toLowerCase()))) freq.set(key, (freq.get(key) ?? 0) + 1);
    cleaned = pages.map((lines) => lines.filter((l) => !l || l.length > 90 || (freq.get(l.replace(/\d+/g, "#").toLowerCase()) ?? 0) < pages.length * 0.4));
  }
  const text = cleaned.map((lines) => lines.join("\n")).join("\n\n").replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2").replace(/\n{3,}/g, "\n\n");
  if (countWords(text) < 20) throw new ExtractError(`${file.name}: little or no selectable text. This looks like a scanned or image-only PDF — run OCR on it or paste its text instead.`);
  const note = doc.numPages > limit
    ? `Read the first ${limit} of ${doc.numPages} pages.`
    : "Text only: tables, charts and scanned pages are not read as visuals.";
  // Cap image findings so a picture-heavy PDF does not flood the review list.
  return makeSource(file.name, "PDF", text, note, imageFindings.slice(0, 40));
}

async function extractDocx(file: File): Promise<SourceRecord> {
  const mammoth = (await import("mammoth/mammoth.browser")) as unknown as { extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  if (countWords(value) < 5) throw new ExtractError(`${file.name}: no readable text found in this Word file.`);
  return makeSource(file.name, "Word", value, "Text only: images and charts inside the document are not read.");
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
