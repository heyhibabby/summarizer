/** Text helpers shared by topic checking, findings and the on-device summarizer. */

const STOP = `about above after again all also although always among and any are because been before being between both but can could did does doing done down during each either else even ever every for from further had has have having her here hers him his how however into its itself just least less like many may might more most much must neither nor not now off once one only other our ours out over own per perhaps rather said same shall she should since some still such than that the their theirs them then there these they this those though through thus too under until upon use used using very was way were what when where whether which while who whom whose why will with within without would yet you your yours`;
export const STOP_WORDS = new Set(STOP.split(/\s+/));

export function countWords(text: string): number {
  return text.trim().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** Very light suffix stripping so "emissions"/"emission" and "baking"/"baked" match. */
export function stem(word: string): string {
  const w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[\p{L}][\p{L}\p{N}]*(?:['’][\p{L}]+)?/gu) ?? [];
  const out: string[] = [];
  for (const token of raw) {
    if (token.length < 3 || STOP_WORDS.has(token)) continue;
    out.push(stem(token.replace(/['’]s$/, "")));
  }
  return out;
}

export type SparseVector = Map<string, number>;

export function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/** TF-IDF vectors (sub-linear tf, smoothed idf) for a list of token lists. */
export function tfidfVectors(tokenLists: string[][]): { vectors: SparseVector[]; idf: Map<string, number> } {
  const df = new Map<string, number>();
  const counts = tokenLists.map((tokens) => termCounts(tokens));
  for (const c of counts) for (const term of c.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const n = tokenLists.length;
  const idf = new Map<string, number>();
  for (const [term, d] of df) idf.set(term, Math.log(1 + n / d));
  const vectors = counts.map((c) => {
    const vector: SparseVector = new Map();
    let norm = 0;
    for (const [term, count] of c) {
      const weight = (1 + Math.log(count)) * (idf.get(term) ?? 0);
      vector.set(term, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, weight] of vector) vector.set(term, weight / norm);
    return vector;
  });
  return { vectors, idf };
}

export function cosine(a: SparseVector, b: SparseVector): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other) dot += weight * other;
  }
  return dot;
}

export function topTerms(vector: SparseVector, limit = 5): string[] {
  return [...vector.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit).map(([term]) => term);
}

/** Remove Markdown/HTML decoration so sentences read as prose. */
export function cleanMarkup(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+•▪◦●■]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s*[-=_*]{3,}\s*$/gm, " ");
}

export type SentenceRecord = { text: string; paragraph: number };

/** Split into sentences, keeping the paragraph index. Falls back to a regex splitter. */
export function splitSentences(raw: string): SentenceRecord[] {
  const cleaned = cleanMarkup(raw);
  const paragraphs = cleaned.split(/\n{2,}/);
  const out: SentenceRecord[] = [];
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "sentence" }) : null;
  paragraphs.forEach((paragraph, index) => {
    const flat = paragraph.replace(/-\n(?=\p{Ll})/gu, "").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
    if (!flat) return;
    const parts = segmenter
      ? [...segmenter.segment(flat)].map((s) => s.segment)
      : (flat.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) ?? [flat]);
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence) out.push({ text: sentence, paragraph: index });
    }
  });
  return out;
}

/** Private-use / symbol-font bullet glyphs that PDFs emit instead of a real bullet. */
const BULLET_GLYPHS = /[ÿ\uFFFD\uF0A7\uF0B7\uF0D8\uF076\uF0FC\u2022\u25AA\u25E6\u25CF\u25A0\u2043]/g;

/** Repair PDF text: stray glyphs become paragraph breaks, soft hyphens vanish, odd spaces are normalised. */
export function normalizeExtracted(text: string): string {
  return text
    .replace(/\u00AD/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s*[ÿ\uFFFD\uF0A7\uF0B7\uF0D8\uF076\uF0FC\u25AA\u25E6\u25CF\u25A0\u2043]\s+(?=\S)/g, "\n\n")
    .replace(/[\uE000-\uF8FF]/g, " ")
    .replace(BULLET_GLYPHS, " ")
    .replace(/[ \t]{2,}/g, " ");
}

const DANGLING = new Set(["gives", "makes", "takes", "shows", "uses", "provides", "allows", "means", "has", "have", "is", "are", "be", "can", "will", "would", "should", "that", "which", "than", "as", "if", "or", "but", "while", "because", "when", "where"]);

/** Sentences that point elsewhere ("see Table 3 on the next page") say nothing on their own. */
const CROSS_REFERENCE = new RegExp(
  [
    "\\b(?:see|refer to|cf\\.?|consult)\\s+(?:also\\s+)?(?:the\\s+)?(?:table|tab\\.|figure|fig\\.|chart|graph|page|pp?\\.|chapter|section|appendix|equation|eq\\.|below|above|next|previous)",
    "\\b(?:in|on|over)\\s+the\\s+(?:following|next|previous|preceding)\\s+(?:pages?|chapters?|sections?|paragraphs?)",
    "\\b(?:on|in)\\s+(?:the\\s+)?(?:next|previous|following|preceding|facing|opposite)\\s+page",
    "\\bas\\s+(?:shown|illustrated|described|discussed|seen|reported|indicated|explained|listed)\\s+(?:in|on|below|above|earlier|previously)\\b",
    "\\b(?:on|at|in)\\s+pages?\\s+\\d+",
    "\\bpp?\\.\\s*\\d+",
    "\\b(?:table of contents|all rights reserved|isbn|copyright)\\b",
    "\\b(?:we|you)\\s+(?:will|shall)\\s+(?:see|discuss|describe|examine|explore|cover)\\b.*\\b(?:later|next|following|chapter|section)",
  ].join("|"),
  "i",
);
export function isCrossReference(sentence: string): boolean {
  return CROSS_REFERENCE.test(sentence);
}

/** Heuristic: is this sentence usable as a standalone summary statement? */
export function isUsableSentence(sentence: string): boolean {
  const words = countWords(sentence);
  if (words < 6 || words > 70) return false;
  const letters = (sentence.match(/\p{L}/gu) ?? []).length;
  if (letters / sentence.length < 0.6) return false;
  if (/^(table|figure|fig\.|chart|graph|image|source|copyright|©|page)\s*[\dIVX]*/i.test(sentence)) return false;
  if (/https?:\/\/\S{25,}/.test(sentence)) return false;
  // Fragments that start mid-sentence (page breaks) or that introduce something else.
  if (!/^[\p{Lu}\p{N}"“‘'(\[]/u.test(sentence)) return false;
  if (/[:;,]$/.test(sentence)) return false;
  // A cut-off sentence (page break, truncated column) ends on a connecting word.
  const last = sentence.replace(/[^\p{L}\s]+$/u, "").trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  if (STOP_WORDS.has(last) || DANGLING.has(last)) return false;
  if (isCrossReference(sentence)) return false;
  return true;
}

/** Words of actual summary content: ignores headings, [n] citation tags and a trailing Sources list. */
export function measureSummaryWords(text: string): number {
  const withoutSources = text.split(/\n#{1,3}\s*Sources\b/i)[0] ?? text;
  const body = withoutSources
    .split("\n")
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join("\n")
    .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, " ");
  return countWords(body);
}
