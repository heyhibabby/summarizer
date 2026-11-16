/**
 * On-device, key-free summarizer.
 *
 * It is EXTRACTIVE: it selects the most representative sentences from the sources (TextRank over
 * TF-IDF similarity + position + length signals), removes near-duplicates with MMR, keeps coverage
 * balanced across sources, and groups the result by theme. It never invents text, but it also
 * cannot rephrase — an AI provider gives more fluent results.
 */
import { cosine, countWords, isUsableSentence, measureSummaryWords, splitSentences, tfidfVectors, tokenize, topTerms, type SparseVector } from "./text";

export type OfflineSource = { id: string; name: string; text: string };

export type OfflineResult = {
  text: string;
  /** Selected sentences in reading order (without citation tags). */
  bullets: string[];
  inputWords: number;
  targetWords: number;
  outputWords: number;
  picked: number;
  perSource: Record<string, number>;
};

type Candidate = {
  source: number;
  position: number;
  paragraph: number;
  firstInParagraph: boolean;
  text: string;
  words: number;
  vector: SparseVector;
  score: number;
};

const MAX_CANDIDATES = 1200;
const DUPLICATE_SIMILARITY = 0.55;
const MIN_TARGET_WORDS = 25;

export function summarizeOffline(
  sources: OfflineSource[],
  options: {
    ratio: number;
    /** Exact word budget (overrides ratio). */
    targetWords?: number;
    /** "themes": bullets grouped under theme headings. "bullets": one flat list in reading order. */
    format?: "themes" | "bullets";
    /** Add [n] source tags (only useful with several sources). */
    citations?: boolean;
    onProgress?: (fraction: number) => void;
  },
): OfflineResult {
  const inputWords = sources.reduce((sum, source) => sum + countWords(source.text), 0);
  const targetWords = Math.min(inputWords, options.targetWords ?? Math.max(Math.round(inputWords * options.ratio), MIN_TARGET_WORDS));
  const empty: OfflineResult = { text: "", bullets: [], inputWords, targetWords, outputWords: 0, picked: 0, perSource: {} };
  if (!inputWords) return empty;

  // 1. Candidate sentences -------------------------------------------------------------------
  const raw: Omit<Candidate, "vector" | "score">[] = [];
  const sourceWordCounts = sources.map((source) => countWords(source.text));
  sources.forEach((source, sourceIndex) => {
    let lastParagraph = -1;
    let position = 0;
    for (const sentence of splitSentences(source.text)) {
      if (!isUsableSentence(sentence.text)) continue;
      raw.push({
        source: sourceIndex,
        position: position++,
        paragraph: sentence.paragraph,
        firstInParagraph: sentence.paragraph !== lastParagraph,
        text: sentence.text,
        words: countWords(sentence.text),
      });
      lastParagraph = sentence.paragraph;
    }
  });
  if (!raw.length) {
    // Nothing sentence-like (e.g. a list of short lines): fall back to the leading text.
    const joined = sources.map((s) => s.text.trim()).join("\n\n").split(/\s+/).slice(0, targetWords).join(" ");
    return { ...empty, text: joined, bullets: joined ? [joined] : [], outputWords: countWords(joined), picked: 0 };
  }
  options.onProgress?.(0.15);

  const tokenLists = raw.map((sentence) => tokenize(sentence.text));
  const { vectors } = tfidfVectors(tokenLists);
  const withVectors: Candidate[] = raw.map((sentence, index) => ({ ...sentence, vector: vectors[index] ?? new Map(), score: 0 }));

  // 2. Centroid + pre-filter ---------------------------------------------------------------------
  const centroid: SparseVector = new Map();
  for (const candidate of withVectors) for (const [term, weight] of candidate.vector) centroid.set(term, (centroid.get(term) ?? 0) + weight);
  const centroidNorm = Math.sqrt([...centroid.values()].reduce((sum, w) => sum + w * w, 0)) || 1;
  for (const [term, weight] of centroid) centroid.set(term, weight / centroidNorm);
  const centrality = withVectors.map((candidate) => cosine(candidate.vector, centroid));

  const sourceLengths = sources.map((_, i) => withVectors.filter((c) => c.source === i).length);
  const positionBonus = (candidate: Candidate): number => {
    const length = sourceLengths[candidate.source] ?? 1;
    if (candidate.position === 0) return 1;
    if (candidate.position === 1) return 0.7;
    if (candidate.firstInParagraph) return 0.45;
    if (candidate.position < length * 0.1) return 0.35;
    if (candidate.position === length - 1) return 0.3;
    return 0;
  };
  const lengthFactor = (words: number): number => (words >= 12 && words <= 38 ? 1 : words < 12 ? 0.82 : 0.88);

  let pool = withVectors.map((candidate, index) => ({ candidate, index, pre: centrality[index]! + 0.15 * positionBonus(candidate) }));
  if (pool.length > MAX_CANDIDATES) pool = pool.sort((a, b) => b.pre - a.pre).slice(0, MAX_CANDIDATES).sort((a, b) => a.index - b.index);
  const items = pool.map((entry) => entry.candidate);
  const itemCentrality = pool.map((entry) => centrality[entry.index]!);
  const n = items.length;
  options.onProgress?.(0.3);

  // 3. Similarity graph via inverted index (skips very common terms) ---------------------------------
  const sim = new Float32Array(n * n);
  const postings = new Map<string, number[]>();
  items.forEach((item, i) => {
    for (const term of item.vector.keys()) {
      const list = postings.get(term);
      if (list) list.push(i);
      else postings.set(term, [i]);
    }
  });
  const commonCutoff = Math.max(30, n * 0.25);
  for (const [term, list] of postings) {
    if (list.length < 2 || list.length > commonCutoff) continue;
    for (let a = 0; a < list.length; a += 1) {
      const i = list[a]!;
      const wi = items[i]!.vector.get(term) ?? 0;
      for (let b = a + 1; b < list.length; b += 1) {
        const j = list[b]!;
        const delta = wi * (items[j]!.vector.get(term) ?? 0);
        sim[i * n + j] = (sim[i * n + j] ?? 0) + delta;
        sim[j * n + i] = (sim[j * n + i] ?? 0) + delta;
      }
    }
  }
  options.onProgress?.(0.55);

  // 4. TextRank ---------------------------------------------------------------------------------------
  const rowSum = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) {
      const value = sim[i * n + j]!;
      if (value > 0.05) sum += value;
    }
    rowSum[i] = sum;
  }
  let rank = new Float32Array(n).fill(1 / n);
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const next = new Float32Array(n).fill(0.15 / n);
    for (let j = 0; j < n; j += 1) {
      let acc = 0;
      for (let i = 0; i < n; i += 1) {
        const value = sim[i * n + j]!;
        if (value > 0.05 && rowSum[i]! > 0) acc += (value / rowSum[i]!) * rank[i]!;
      }
      next[j] = (next[j] ?? 0) + 0.85 * acc;
    }
    rank = next;
  }
  const maxRank = Math.max(...rank) || 1;
  const maxCentral = Math.max(...itemCentrality) || 1;
  items.forEach((item, i) => {
    const base = 0.55 * (rank[i]! / maxRank) + 0.3 * (itemCentrality[i]! / maxCentral) + 0.15 * positionBonus(item);
    item.score = base * lengthFactor(item.words);
  });
  options.onProgress?.(0.75);

  // 5. Greedy MMR selection with per-source balance --------------------------------------------------------
  const quota = sourceWordCounts.map((words) => (targetWords * words) / inputWords);
  const usedWords = sources.map(() => 0);
  const chosen: number[] = [];
  const chosenSet = new Set<number>();
  let total = 0;
  const lambda = 0.72;
  // If near-duplicate removal leaves us well short of the budget, relax it step by step instead of returning a tiny summary.
  for (const duplicateLimit of [DUPLICATE_SIMILARITY, 0.7, 0.85, 1.01]) {
    while (total < targetWords * 0.94) {
      let best = -1;
      let bestValue = -Infinity;
      const room = targetWords * 1.12 - total;
      for (let i = 0; i < n; i += 1) {
        if (chosenSet.has(i)) continue;
        const item = items[i]!;
        if (chosen.length && item.words > room) continue;
        let redundancy = 0;
        for (const c of chosen) redundancy = Math.max(redundancy, sim[i * n + c]!);
        if (redundancy >= duplicateLimit) continue;
        let value = lambda * item.score - (1 - lambda) * redundancy;
        const q = quota[item.source] ?? 0;
        if ((usedWords[item.source] ?? 0) > q * 1.25 + 20) value *= 0.55;
        if ((usedWords[item.source] ?? 0) === 0) value *= 1.2; // make sure every source is represented
        if (value > bestValue) {
          bestValue = value;
          best = i;
        }
      }
      if (best < 0) break;
      chosen.push(best);
      chosenSet.add(best);
      const item = items[best]!;
      total += item.words;
      usedWords[item.source] = (usedWords[item.source] ?? 0) + item.words;
    }
    if (total >= targetWords * 0.8) break;
  }
  options.onProgress?.(0.9);

  // 6. Group by theme, order by reading flow ------------------------------------------------------------------
  type Group = { members: number[] };
  const groups: Group[] = [];
  const byScore = [...chosen].sort((a, b) => items[b]!.score - items[a]!.score);
  for (const index of byScore) {
    let home: Group | undefined;
    let homeSim = 0.16;
    for (const group of groups) {
      const s = Math.max(...group.members.map((m) => sim[index * n + m]!));
      if (s >= homeSim) {
        home = group;
        homeSim = s;
      }
    }
    if (home) home.members.push(index);
    else groups.push({ members: [index] });
  }
  const order = (a: number, b: number) => items[a]!.source - items[b]!.source || items[a]!.position - items[b]!.position;
  groups.forEach((group) => group.members.sort(order));
  groups.sort((g1, g2) => order(g1.members[0]!, g2.members[0]!));

  const surface = (term: string, members: number[]): string => {
    for (const m of members) {
      for (const word of items[m]!.text.toLowerCase().match(/[\p{L}][\p{L}\p{N}]+/gu) ?? []) if (tokenize(word)[0] === term) return word;
    }
    return term;
  };
  const label = (members: number[], max = 3): string => {
    const merged: SparseVector = new Map();
    for (const m of members) for (const [term, weight] of items[m]!.vector) merged.set(term, (merged.get(term) ?? 0) + weight);
    const terms = topTerms(merged, max).map((t) => surface(t, members)).map((t) => t.charAt(0).toUpperCase() + t.slice(1));
    return terms.length > 1 ? `${terms.slice(0, -1).join(", ")} & ${terms[terms.length - 1]}` : (terms[0] ?? "Key points");
  };
  const allMembers = groups.flatMap((g) => g.members);
  const title = `Summary: ${label(allMembers, 3)}`;
  const tag = (item: Candidate) => (options.citations ? ` [${item.source + 1}]` : "");
  const sentenceOf = (index: number) => `${items[index]!.text.replace(/\s+/g, " ").trim()}${tag(items[index]!)}`;
  const plain = (index: number) => items[index]!.text.replace(/\s+/g, " ").trim();

  const format = options.format ?? "themes";
  const lines: string[] = [];
  let bullets: string[];
  if (format === "bullets") {
    const ordered = [...allMembers].sort(order);
    bullets = ordered.map(plain);
    lines.push(...ordered.map((i) => `- ${sentenceOf(i)}`));
  } else {
    bullets = allMembers.map(plain);
    lines.push(`# ${title}`, "");
    const useHeadings = groups.length >= 2 && chosen.length >= 5;
    if (useHeadings) {
      for (const group of groups) lines.push(`## ${label(group.members, 2)}`, ...group.members.map((i) => `- ${sentenceOf(i)}`), "");
    } else {
      lines.push(...allMembers.map((i) => `- ${sentenceOf(i)}`), "");
    }
  }
  const text = lines.join("\n").trim();

  const perSource: Record<string, number> = {};
  sources.forEach((source, i) => {
    perSource[source.id] = chosen.filter((c) => items[c]!.source === i).length;
  });
  options.onProgress?.(1);
  return { text, bullets, inputWords, targetWords, outputWords: measureSummaryWords(text), picked: chosen.length, perSource };
}
