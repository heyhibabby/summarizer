import { countWords } from "./text";

export type Chapter = {
  id: string;
  title: string;
  text: string;
  startPage?: number;
  endPage?: number;
  included: boolean;
};

/** One line of source text. `page` is 1-based; `size` is the font height when known (PDF). */
export type Line = { text: string; page?: number; size?: number };
export type OutlineEntry = { title: string; page: number; level: number };

const FRONT_BACK = /^(?:table of )?contents?$|^index$|^bibliograph|^references?$|^acknowledg|^copyright|^about the (?:author|book)|^glossary$|^list of (?:figures|tables|illustrations)|^notes?$|^front matter$|^cover$|^title page$/i;

export const isBackOrFrontMatter = (title: string): boolean => FRONT_BACK.test(title.trim().replace(/[.:]+$/, ""));

const CHAPTER_WORD = /^(?:chapter|capitolo|chapitre|kapitel|cap[ií]tulo|part|parte|partie|teil|unit|lesson|module)\s+(?:[0-9]+|[IVXLC]+|one|two|three|four|five|six|seven|eight|nine|ten|[a-z]+)\b[\s.:)\-–—]*(.*)$/i;
const MARKDOWN_HEADING = /^(#{1,2})\s+(.+?)\s*#*$/;
const NUMBERED_HEADING = /^(\d{1,2})[.)]?\s+(\p{Lu}[^.!?;]{2,80})$/u;

const clean = (title: string): string =>
  title
    .replace(/\.{2,}\s*\d+\s*$/, "")
    .replace(/\s+\d{1,4}$/, (m, offset: number, whole: string) => (/\d$/.test(whole.slice(0, offset)) ? m : ""))
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, "")
    .trim()
    .slice(0, 120);

const wordsOf = (lines: Line[]): number => lines.reduce((sum, l) => sum + countWords(l.text), 0);

function toChapter(lines: Line[], title: string, index: number): Chapter {
  const pages = lines.map((l) => l.page).filter((p): p is number => typeof p === "number");
  const body = lines.map((l) => l.text).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const chapter: Chapter = { id: `c${index}`, title: title || `Section ${index + 1}`, text: body, included: !isBackOrFrontMatter(title) };
  if (pages.length) {
    chapter.startPage = Math.min(...pages);
    chapter.endPage = Math.max(...pages);
  }
  return chapter;
}

function sliceAt(lines: Line[], starts: { index: number; title: string }[]): Chapter[] {
  const chapters: Chapter[] = [];
  const first = starts[0];
  if (first && first.index > 0) {
    const front = lines.slice(0, first.index);
    if (wordsOf(front) >= 150) {
      const c = toChapter(front, "Front matter", 0);
      c.included = false;
      chapters.push(c);
    }
  }
  starts.forEach((start, i) => {
    const end = starts[i + 1]?.index ?? lines.length;
    const body = lines.slice(start.index + 1, end);
    chapters.push(toChapter(body, start.title, chapters.length));
  });
  // A heading with almost no body (e.g. a divider page) is merged into the next chapter's title instead of standing alone.
  return chapters.filter((c, i) => countWords(c.text) >= 25 || i === chapters.length - 1 || c.title === "Front matter").map((c, i) => ({ ...c, id: `c${i}` }));
}

function byRegex(lines: Line[]): { index: number; title: string }[] | null {
  const markdown: { index: number; title: string }[] = [];
  const chapterWord: { index: number; title: string }[] = [];
  const numbered: { index: number; title: string; n: number }[] = [];
  const caps: { index: number; title: string }[] = [];
  lines.forEach((line, index) => {
    const text = line.text.trim();
    if (!text || text.length > 100) return;
    const md = MARKDOWN_HEADING.exec(text);
    if (md) return void markdown.push({ index, title: clean(md[2]!) });
    const ch = CHAPTER_WORD.exec(text);
    if (ch) {
      const rest = clean(ch[1] ?? "");
      const label = text.replace(/[\s.:)\-–—]+.*$/, (m) => m.slice(0, 0));
      const head = /^\S+\s+\S+/.exec(text)?.[0] ?? label;
      return void chapterWord.push({ index, title: rest ? `${head.replace(/[:.]$/, "")} — ${rest}` : head });
    }
    const nm = NUMBERED_HEADING.exec(text);
    if (nm && countWords(text) <= 12) numbered.push({ index, title: clean(text), n: Number(nm[1]) });
    if (/^[\p{Lu}\d][\p{Lu}\d\s&,'’:\-–]{4,70}$/u.test(text) && /\p{Lu}{3}/u.test(text) && countWords(text) <= 9 && !/\d{3,}/.test(text)) caps.push({ index, title: clean(text) });
  });
  if (markdown.length >= 2) return markdown;
  if (chapterWord.length >= 2) return chapterWord;
  // Numbered headings only count when they form a running sequence (1, 2, 3 …).
  const seq = numbered.filter((h, i) => i === 0 || h.n > numbered[i - 1]!.n || h.n === 1);
  if (seq.length >= 3 && seq.length <= 120) {
    const ordered = seq.filter((h, i) => i === 0 || h.n === seq[i - 1]!.n + 1 || h.n === 1);
    if (ordered.length >= 3) return ordered;
  }
  if (caps.length >= 3 && caps.length <= 80) {
    // ALL-CAPS lines are only chapter titles if they are well separated.
    const spaced = caps.filter((h, i) => i === 0 || wordsOf(lines.slice(caps[i - 1]!.index, h.index)) >= 150);
    if (spaced.length >= 3) return spaced;
  }
  return null;
}

/** Headings in a larger font than the body text (PDF). Picks the highest size tier that repeats like chapter titles. */
function byFontSize(lines: Line[]): { index: number; title: string }[] | null {
  const sized = lines.filter((l) => l.size && l.text.trim());
  if (sized.length < 40) return null;
  const weighted = new Map<number, number>();
  for (const l of sized) weighted.set(Math.round(l.size!), (weighted.get(Math.round(l.size!)) ?? 0) + l.text.length);
  const body = [...weighted.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const tiers = new Map<number, number[]>();
  lines.forEach((line, index) => {
    const text = line.text.trim();
    if (!line.size || !text || countWords(text) > 14 || /[.!?]$/.test(text) || !/\p{L}{2}/u.test(text)) return;
    const size = Math.round(line.size);
    if (size < body * 1.25) return;
    const list = tiers.get(size) ?? [];
    list.push(index);
    tiers.set(size, list);
  });
  const ordered = [...tiers.entries()].sort((a, b) => b[0] - a[0]);
  for (const [, indexes] of ordered) {
    if (indexes.length < 3 || indexes.length > 90) continue;
    // Merge consecutive heading lines ("Chapter 3" + "Freezing point") into one title.
    const starts: { index: number; title: string }[] = [];
    for (const index of indexes) {
      const previous = starts[starts.length - 1];
      const text = clean(lines[index]!.text);
      if (previous && index - previous.index <= 2 && lines.slice(previous.index + 1, index).every((l) => !l.text.trim())) {
        previous.title = `${previous.title} — ${text}`;
        (previous as { index: number; title: string; last?: number }).last = index;
      } else starts.push({ index, title: text });
    }
    if (starts.length >= 3) return starts.map((s) => ({ index: (s as { last?: number }).last ?? s.index, title: s.title }));
  }
  return null;
}

function byOutline(lines: Line[], outline: OutlineEntry[]): Chapter[] | null {
  const levels = [...new Set(outline.map((o) => o.level))].sort((a, b) => a - b);
  for (const level of levels) {
    let entries = outline.filter((o) => o.level === level && o.page >= 1);
    // Collapse bookmarks that share a page and drop repeats.
    entries = entries.filter((o, i) => i === 0 || o.page !== entries[i - 1]!.page).sort((a, b) => a.page - b.page);
    if (entries.length < 2 || entries.length > 150) continue;
    const chapters: Chapter[] = [];
    const firstPage = entries[0]!.page;
    const frontLines = lines.filter((l) => (l.page ?? 0) < firstPage);
    if (wordsOf(frontLines) >= 150) {
      const front = toChapter(frontLines, "Front matter", 0);
      front.included = false;
      chapters.push(front);
    }
    entries.forEach((entry, i) => {
      const next = entries[i + 1]?.page ?? Number.POSITIVE_INFINITY;
      const body = lines.filter((l) => (l.page ?? 0) >= entry.page && (l.page ?? 0) < next);
      // Drop the heading line itself if it repeats the bookmark title.
      const title = clean(entry.title);
      const trimmed = body[0] && clean(body[0].text).toLowerCase() === title.toLowerCase() ? body.slice(1) : body;
      chapters.push(toChapter(trimmed, title, chapters.length));
    });
    const usable = chapters.filter((c) => countWords(c.text) >= 25 || c.title === "Front matter");
    if (usable.length >= 2) return usable.map((c, i) => ({ ...c, id: `c${i}` }));
  }
  return null;
}

/** Last resort: equal-sized parts so even an unstructured text still gets a readable, sectioned summary. */
function asParts(lines: Line[], partWords = 3000): Chapter[] {
  const total = wordsOf(lines);
  if (total < partWords * 1.5) return [toChapter(lines, "Whole document", 0)];
  const count = Math.max(2, Math.round(total / partWords));
  const per = total / count;
  const parts: Line[][] = [];
  let current: Line[] = [];
  let words = 0;
  for (const line of lines) {
    current.push(line);
    words += countWords(line.text);
    if (words >= per && parts.length < count - 1 && !line.text.trim()) {
      parts.push(current);
      current = [];
      words = 0;
    }
  }
  if (current.length) parts.push(current);
  return parts.map((part, i) => {
    const pages = part.map((l) => l.page).filter((p): p is number => typeof p === "number");
    const title = pages.length ? `Pages ${Math.min(...pages)}–${Math.max(...pages)}` : `Part ${i + 1}`;
    return toChapter(part, title, i);
  });
}

export type ChapterResult = { chapters: Chapter[]; method: "bookmarks" | "font" | "headings" | "parts" };

export function buildChapters(lines: Line[], outline: OutlineEntry[] = []): ChapterResult {
  if (outline.length) {
    const viaOutline = byOutline(lines, outline);
    if (viaOutline) return { chapters: viaOutline, method: "bookmarks" };
  }
  const viaFont = byFontSize(lines);
  if (viaFont) {
    const chapters = sliceAt(lines, viaFont);
    if (chapters.length >= 2) return { chapters, method: "font" };
  }
  const viaRegex = byRegex(lines);
  if (viaRegex) {
    const chapters = sliceAt(lines, viaRegex);
    if (chapters.length >= 2) return { chapters, method: "headings" };
  }
  return { chapters: asParts(lines), method: "parts" };
}

/** Chapters for plain text / Markdown (no pages or fonts). */
export function chaptersFromText(text: string): ChapterResult {
  return buildChapters(text.split("\n").map((t) => ({ text: t })));
}
