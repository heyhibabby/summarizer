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
  const seen = new Map<string, number>();
  for (const l of lines) if (l.text.trim()) seen.set(normKey(l.text), (seen.get(normKey(l.text)) ?? 0) + 1);
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
    const repeated = (seen.get(normKey(text)) ?? 0) >= 3; // same line on many pages = running head
    if (nm && !repeated && countWords(text) <= 12) numbered.push({ index, title: clean(text), n: Number(nm[1]) });
    if (!repeated && plausibleTitle(text) && /^[\p{Lu}\d][\p{Lu}\d\s&,'’:\-–]{4,70}$/u.test(text) && /\p{Lu}{3}/u.test(text) && countWords(text) <= 9 && !/\d{3,}/.test(text)) caps.push({ index, title: clean(text) });
  });
  if (markdown.length >= 2) return markdown;
  const dedupedChapterWord = chapterWord.filter((h, i) => i === 0 || normKey(h.title) !== normKey(chapterWord[i - 1]!.title));
  if (dedupedChapterWord.length >= 2) return dedupedChapterWord;
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

// Exact text (digits kept): "Chapter 3" and "Chapter 4" are different headings, but the same running head on 40 pages is not.
const normKey = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
/** Looks like a real title, not a running head, page label or garbled glyph run like "FcDx". */
const plausibleTitle = (t: string): boolean => {
  const text = t.trim();
  if ((text.match(/\p{L}/gu) ?? []).length < 4) return false;
  if (!/[aeiouyàèéìòùáíóúäöü]/i.test(text)) return false;
  if (!/^[\p{Lu}\d"“(]/u.test(text)) return false;
  if (!/\s/.test(text) && /\p{Ll}\p{Lu}/u.test(text)) return false; // single word with inner capital: "FcDx"
  return true;
};

/** All heading-size tiers, largest first, each as a list of chapter starts. */
function fontTiers(lines: Line[]): { index: number; title: string }[][] {
  const sized = lines.filter((l) => l.size && l.text.trim());
  if (sized.length < 40) return [];
  const weighted = new Map<number, number>();
  for (const l of sized) weighted.set(Math.round(l.size!), (weighted.get(Math.round(l.size!)) ?? 0) + l.text.length);
  const body = [...weighted.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  // Text that repeats many times is a running head, not a chapter title.
  const seen = new Map<string, number>();
  for (const l of sized) seen.set(normKey(l.text), (seen.get(normKey(l.text)) ?? 0) + 1);
  const tiers = new Map<number, number[]>();
  lines.forEach((line, index) => {
    const text = line.text.trim();
    if (!line.size || !text || countWords(text) > 14 || /[.!?]$/.test(text) || !plausibleTitle(text)) return;
    if ((seen.get(normKey(text)) ?? 0) >= 3) return;
    const size = Math.round(line.size);
    if (size < body * 1.25) return;
    const list = tiers.get(size) ?? [];
    list.push(index);
    tiers.set(size, list);
  });
  const out: { index: number; title: string }[][] = [];
  for (const [, indexes] of [...tiers.entries()].sort((a, b) => b[0] - a[0])) {
    if (indexes.length < 3 || indexes.length > 120) continue;
    const starts: { index: number; title: string; last?: number }[] = [];
    for (const index of indexes) {
      const previous = starts[starts.length - 1];
      const text = clean(lines[index]!.text);
      if (previous && index - (previous.last ?? previous.index) <= 2 && lines.slice((previous.last ?? previous.index) + 1, index).every((l) => !l.text.trim())) {
        previous.title = `${previous.title} — ${text}`;
        previous.last = index;
      } else starts.push({ index, title: text });
    }
    if (starts.length >= 3) out.push(starts.map((st) => ({ index: st.last ?? st.index, title: st.title })));
  }
  return out;
}

/** Books that number captions by chapter ("Table 33-2", "Figure 7-4") reveal which chapter a page belongs to. */
function byCaptionNumbers(lines: Line[]): { index: number; title: string }[] | null {
  const re = /^(?:table|tab\.|figure|fig\.|chart|graph|exhibit)\s+(\d{1,3})\s*[-–.]\s*\d{1,3}\b/i;
  const first = new Map<number, number>();
  lines.forEach((l, i) => {
    const m = re.exec(l.text.trim());
    if (m && !first.has(Number(m[1]))) first.set(Number(m[1]), i);
  });
  const entries = [...first.entries()].sort((a, b) => a[1] - b[1]);
  const mono = entries.filter(([n], i) => i === 0 || n > entries[i - 1]![0]);
  if (mono.length < 4 || mono.length > 120) return null;
  return mono.map(([n, index]) => {
    const page = lines[index]!.page;
    const start = page ? lines.findIndex((l) => l.page === page) : index; // include the whole page
    return { index: Math.max(0, start - 1), title: `Chapter ${n}` };
  });
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

/** Equal-sized sections. By page count when pages are known, otherwise by words. */
function asParts(lines: Line[], opts: { pagesPer?: number; partWords?: number } = {}): Chapter[] {
  const total = wordsOf(lines);
  const pages = lines.map((l) => l.page).filter((p): p is number => typeof p === "number");
  const lastPage = pages.length ? Math.max(...pages) : 0;
  if (lastPage && (opts.pagesPer || total > 6000)) {
    const per = opts.pagesPer ?? Math.max(5, Math.round(lastPage / 24));
    const groups = new Map<number, Line[]>();
    for (const line of lines) {
      const key = Math.floor(((line.page ?? 1) - 1) / per);
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([key, part], i) => toChapter(part, `Pages ${key * per + 1}–${Math.min(lastPage, key * per + per)}`, i)).filter((c) => countWords(c.text) >= 25);
  }
  const partWords = opts.partWords ?? 3000;
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
  return parts.map((part, i) => toChapter(part, `Part ${i + 1}`, i));
}

export type ChapterMethod = "bookmarks" | "font" | "headings" | "captions" | "parts";
export type ChapterResult = { chapters: Chapter[]; method: ChapterMethod };
export type SplitChoice = "auto" | "headings" | "font" | "captions" | "pages5" | "pages10" | "pages20";

export const SPLIT_LABELS: Record<SplitChoice, string> = {
  auto: "Automatic",
  headings: "“Chapter N” headings",
  font: "Large heading text",
  captions: "Table / figure numbers",
  pages5: "Every 5 pages",
  pages10: "Every 10 pages",
  pages20: "Every 20 pages",
};

/** 0 is perfect. Penalises too few/many sections and one section swallowing most of the book. */
function stats(chapters: Chapter[]) {
  const words = chapters.map((c) => countWords(c.text));
  const total = words.reduce((a, b) => a + b, 0) || 1;
  const n = chapters.filter((c) => c.included).length;
  return { n, share: Math.max(...words) / total };
}
function quality(chapters: Chapter[]): number {
  const { n, share } = stats(chapters);
  return (n >= 5 && n <= 70 ? 0 : n >= 2 ? 0.3 : 1.5) + share;
}
/** A real structure: sensible score, and for longer books no section holding ~40%+ of the text. */
const acceptable = (chapters: Chapter[]): boolean => {
  const { n, share } = stats(chapters);
  return quality(chapters) < 1.2 && (n < 6 || share <= 0.4);
};

export function buildChapters(lines: Line[], outline: OutlineEntry[] = [], choice: SplitChoice = "auto"): ChapterResult {
  if (choice === "pages5" || choice === "pages10" || choice === "pages20") return { chapters: asParts(lines, { pagesPer: Number(choice.slice(5)), partWords: 1500 }), method: "parts" };
  const forced = (starts: { index: number; title: string }[] | null, method: ChapterMethod): ChapterResult | null => {
    if (!starts) return null;
    const chapters = sliceAt(lines, starts);
    return chapters.length >= 2 ? { chapters, method } : null;
  };

  if (choice === "headings") return forced(byRegex(lines), "headings") ?? { chapters: [], method: "headings" };
  if (choice === "captions") return forced(byCaptionNumbers(lines), "captions") ?? { chapters: [], method: "captions" };
  if (choice === "font") {
    const tiers = fontTiers(lines);
    const best = tiers.map((t) => forced(t, "font")).filter((r): r is ChapterResult => !!r).sort((a, b) => quality(a.chapters) - quality(b.chapters))[0];
    return best ?? { chapters: [], method: "font" };
  }

  // Automatic: bookmarks if they give a sensible split, otherwise the best-balanced candidate.
  if (outline.length) {
    const viaOutline = byOutline(lines, outline);
    if (viaOutline && acceptable(viaOutline)) return { chapters: viaOutline, method: "bookmarks" };
  }
  const candidates: ChapterResult[] = [];
  for (const tier of fontTiers(lines)) {
    const r = forced(tier, "font");
    if (r) candidates.push(r);
  }
  const regex = forced(byRegex(lines), "headings");
  if (regex) candidates.push(regex);
  const ranked = candidates.map((r) => ({ r, q: quality(r.chapters) })).sort((a, b) => a.q - b.q);
  const good = ranked.find((x) => acceptable(x.r.chapters));
  if (good) return good.r;
  const byNumber = forced(byCaptionNumbers(lines), "captions");
  if (byNumber && acceptable(byNumber.chapters)) return byNumber;
  return { chapters: asParts(lines), method: "parts" };
}

/** Chapters for plain text / Markdown (no pages or fonts). */
export function chaptersFromText(text: string): ChapterResult {
  return buildChapters(text.split("\n").map((t) => ({ text: t })));
}
