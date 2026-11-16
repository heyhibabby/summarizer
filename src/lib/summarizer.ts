import { cosine, countWords, tfidfVectors, tokenize, topTerms } from "./text";

export { countWords };

export type SourceKind = "PDF" | "Word" | "Text" | "Markdown" | "Pasted text" | "Article";

export type Finding = {
  id: string;
  kind: "image" | "table" | "chart";
  label: string;
  excerpt: string;
  included: boolean;
  /** Exact text removed from the input when this finding is excluded (empty for non-text objects). */
  remove: string;
  page?: number;
};

export type SourceRecord = {
  id: string;
  name: string;
  kind: SourceKind;
  text: string;
  status: "ready" | "error";
  note?: string;
  findings: Finding[];
};

export const DEFAULT_RATIO = 0.05;

export function targetWordCount(inputWords: number, ratio: number = DEFAULT_RATIO): number {
  return Math.max(1, Math.round(inputWords * ratio));
}

/* ----------------------------------------------------------------------------------------- */
/* Topic comparison                                                                          */
/* ----------------------------------------------------------------------------------------- */

export type TopicAnalysis = {
  scores: Record<string, number>;
  outliers: string[];
  /** Only two sources and they look unrelated — there is no "majority" to compare against. */
  pairWarning: boolean;
  keywords: Record<string, string[]>;
};

function surfaceTerms(text: string, stems: string[]): string[] {
  const wanted = new Set(stems);
  const best = new Map<string, Map<string, number>>();
  const words = text.toLowerCase().match(/[\p{L}][\p{L}\p{N}]{2,}/gu) ?? [];
  for (const word of words.slice(0, 40_000)) {
    const [stemmed] = tokenize(word);
    if (!stemmed || !wanted.has(stemmed)) continue;
    const forms = best.get(stemmed) ?? new Map<string, number>();
    forms.set(word, (forms.get(word) ?? 0) + 1);
    best.set(stemmed, forms);
  }
  return stems.map((stem) => [...(best.get(stem) ?? new Map([[stem, 1]])).entries()].sort((a, b) => b[1] - a[1])[0]![0]);
}

export function analyzeTopics(sources: Pick<SourceRecord, "id" | "text">[]): TopicAnalysis {
  const scores: Record<string, number> = {};
  const keywords: Record<string, string[]> = {};
  if (!sources.length) return { scores, outliers: [], pairWarning: false, keywords };
  const { vectors } = tfidfVectors(sources.map((s) => tokenize(s.text)));
  sources.forEach((source, i) => {
    keywords[source.id] = surfaceTerms(source.text, topTerms(vectors[i]!, 5));
  });
  if (sources.length < 2) return { scores, outliers: [], pairWarning: false, keywords };

  const n = sources.length;
  const pair: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) pair[i]![j] = pair[j]![i] = cosine(vectors[i]!, vectors[j]!);
  const mean = sources.map((_, i) => pair[i]!.filter((_, j) => j !== i).reduce((a, b) => a + b, 0) / (n - 1));
  sources.forEach((s, i) => {
    scores[s.id] = mean[i]!;
  });

  if (n === 2) return { scores, outliers: [], pairWarning: pair[0]![1]! < 0.08, keywords };

  const sorted = [...mean].sort((a, b) => a - b);
  const typical = sorted[Math.floor(n / 2)] ?? 0;
  const maxOutliers = Math.floor((n - 1) / 2); // outliers must be a minority
  const outliers = sources
    .map((s, i) => ({ id: s.id, score: mean[i]! }))
    .filter((x) => x.score < 0.5 * typical && x.score < 0.2)
    .sort((a, b) => a.score - b.score)
    .slice(0, maxOutliers)
    .map((x) => x.id);
  return { scores, outliers, pairWarning: false, keywords };
}

export function findTopicOutliers(sources: Pick<SourceRecord, "id" | "text">[]): string[] {
  return analyzeTopics(sources).outliers;
}

/* ----------------------------------------------------------------------------------------- */
/* Visual-content findings (text-detectable only)                                            */
/* ----------------------------------------------------------------------------------------- */

const CAPTION: { kind: Finding["kind"]; pattern: RegExp }[] = [
  { kind: "table", pattern: /^(?:table|tbl\.?)\s*[\dIVX]+\s*[.:)\-–—]?\s*/i },
  { kind: "chart", pattern: /^(?:figure|fig\.?|chart|graph|plot|exhibit)\s*[\dIVX]+\s*[.:)\-–—]?\s*/i },
  { kind: "image", pattern: /^(?:image|photo|photograph|illustration|diagram|screenshot)\s*[\dIVX]*\s*[.:)\-–—]\s*/i },
];
const REFERENCE = /\b(?:see|shown in|as shown in|illustrated in|refer to|depicted in|presented in)\s+(?:the\s+)?(table|figure|fig\.|chart|graph|diagram|image)\b/i;

export function findReviewFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const push = (kind: Finding["kind"], label: string, excerpt: string, remove: string) => {
    const clipped = excerpt.replace(/\s+/g, " ").trim().slice(0, 200);
    const key = `${kind}:${clipped}`;
    if (!clipped || seen.has(key) || findings.length >= 60) return;
    seen.add(key);
    findings.push({ id: `${kind}-${findings.length}`, kind, label, excerpt: clipped, included: true, remove });
  };

  const lines = text.split(/\n/);
  // Markdown tables: 2+ consecutive pipe rows.
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i]!.match(/\|/g) ?? []).length >= 2) {
      let j = i;
      while (j < lines.length && (lines[j]!.match(/\|/g) ?? []).length >= 2) j += 1;
      if (j - i >= 2) {
        push("table", "Table", lines[i]!, lines.slice(i, j).join("\n"));
        i = j;
      }
    }
  }
  for (const match of text.matchAll(/!\[([^\]]*)\]\([^)]*\)/g)) push("image", "Image", match[1] || "Embedded image", match[0]);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.length > 400) continue;
    const caption = CAPTION.find(({ pattern }) => pattern.test(line));
    if (caption) {
      push(caption.kind, caption.kind[0]!.toUpperCase() + caption.kind.slice(1), line, line);
      continue;
    }
    const ref = REFERENCE.exec(line);
    if (ref) {
      const word = ref[1]!.toLowerCase();
      const kind: Finding["kind"] = word.startsWith("table") ? "table" : word === "image" ? "image" : "chart";
      push(kind, `${kind[0]!.toUpperCase()}${kind.slice(1)} mention`, line, "");
    }
  }
  return findings;
}

export function textWithoutExcludedFindings(source: Pick<SourceRecord, "text" | "findings">): string {
  return source.findings
    .filter((finding) => !finding.included && finding.remove)
    .reduce((text, finding) => text.split(finding.remove).join(""), source.text)
    .trim();
}

export function deduplicateLines(text: string): string {
  const seen = new Set<string>();
  return text
    .split(/\n/)
    .filter((line) => {
      const key = line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (!key) return true; // keep blank lines (paragraph breaks)
      if (key.length < 25) return true; // headings / very short lines are allowed to repeat
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
