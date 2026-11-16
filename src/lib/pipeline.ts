import { summarizeOffline } from "./extractive";
import { complete, PROVIDERS, ProviderError, type ProviderId } from "./providers";
import { countWords, measureSummaryWords, splitSentences } from "./text";
import { deduplicateLines } from "./summarizer";
import type { Visual } from "./visuals";

export type PreparedChapter = { id: string; title: string; text: string; pages?: string; visuals: Visual[] };
export type PreparedSource = { id: string; name: string; text: string; chapters?: PreparedChapter[] };
export type VisualNote = { kind: string; sourceName: string; excerpt: string };

export type Engine = { kind: "offline" } | { kind: "ai"; provider: ProviderId; key: string; model: string };

export type SummarySection = {
  id: string;
  sourceName: string;
  sourceIndex: number;
  title: string;
  pages?: string;
  bullets: string[];
  visuals: Visual[];
  failed?: string;
};

export type RunInput = {
  engine: Engine;
  sources: PreparedSource[];
  ratio: number;
  /** Summarize chapter by chapter when chapters exist. */
  byChapter: boolean;
  keptVisuals: VisualNote[];
  signal: AbortSignal;
  onProgress: (label: string, fraction: number) => void;
};

export type RunResult = {
  text: string;
  outline?: SummarySection[];
  engineLabel: string;
  inputWords: number;
  targetWords: number;
  outputWords: number;
  requests: number;
  notes: string[];
};

const MIN_TARGET = 25;
const MIN_SECTION_TARGET = 40;

export function sourcesSection(sources: { name: string }[]): string {
  return `\n\n## Sources\n${sources.map((s, i) => `${i + 1}. ${s.name}`).join("\n")}`;
}

function stripSources(text: string): string {
  return text.replace(/\n+#{1,3}\s*Sources?\b[\s\S]*$/i, "").trim();
}

type Piece = { n: number; name: string; text: string; words: number };
export type Chunk = { pieces: Piece[]; words: number };

/** Split sources into chunks of at most `limit` words, breaking on paragraph boundaries. */
export function chunkSources(sources: { name: string; text: string }[], limit: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk = { pieces: [], words: 0 };
  const flush = () => {
    if (current.pieces.length) chunks.push(current);
    current = { pieces: [], words: 0 };
  };
  sources.forEach((source, index) => {
    const paragraphs = source.text.split(/\n{2,}/).flatMap((p) => {
      const words = p.split(/\s+/);
      if (words.length <= limit / 2) return [p];
      const parts: string[] = [];
      for (let i = 0; i < words.length; i += Math.floor(limit / 2)) parts.push(words.slice(i, i + Math.floor(limit / 2)).join(" "));
      return parts;
    });
    let buffer: string[] = [];
    let bufferWords = 0;
    const commit = () => {
      if (!buffer.length) return;
      current.pieces.push({ n: index + 1, name: source.name, text: buffer.join("\n\n"), words: bufferWords });
      current.words += bufferWords;
      buffer = [];
      bufferWords = 0;
    };
    for (const paragraph of paragraphs) {
      const words = countWords(paragraph);
      if (current.words + bufferWords + words > limit && current.words + bufferWords > 0) {
        commit();
        flush();
      }
      buffer.push(paragraph);
      bufferWords += words;
    }
    commit();
  });
  flush();
  return chunks;
}

const renderPieces = (pieces: Piece[], withNames: boolean) => pieces.map((p) => (withNames ? `[SOURCE ${p.n}: ${p.name}]\n${p.text}` : p.text)).join("\n\n");

const NOISE_RULES = `Ignore page numbers, running headers and footers, tables of contents, index entries, and cross-references such as "see Table 3 on the next page" or "in the following pages". Never mention page numbers.`;

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderError("aborted", "Stopped.");
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/* ---------------------------------------------------------------------------------------- */
/* Prompts                                                                                  */
/* ---------------------------------------------------------------------------------------- */

function sectionPrompt(title: string, body: string, target: number, part?: { index: number; total: number }): string {
  const where = part ? `part ${part.index} of ${part.total} of the section` : "the section";
  return `Summarize ${where} "${title}" as a bullet list of its most important points, in about ${target} words in total.

Rules:
- Output only lines that start with "- ". One self-contained point per bullet (one or two sentences). No title, no preamble, no citations.
- Keep key definitions, numbers, units, formulas' meaning, names and qualifications. Do not add facts that are not in the text.
- ${NOISE_RULES}
- Write in the language of the text.

Text:
${body}`;
}

function mergeBulletsPrompt(title: string, body: string, target: number): string {
  return `Combine the partial bullet summaries below of the section "${title}" into ONE bullet list of about ${target} words. Remove repeats, keep the most important points, and keep every line starting with "- ". No preamble, no title.

${body}`;
}

function mergedPrompt(body: string, target: number, totalWords: number, count: number, cite: boolean, visuals: VisualNote[]): string {
  const visualNote = visuals.length
    ? `\nThe reader chose to keep these references to visual elements (you only see their text, not the visuals — do not describe what they show):\n${visuals.map((v) => `- [${v.kind}] ${v.sourceName}: ${v.excerpt}`).join("\n")}\n`
    : "";
  return `You are a careful summarizer. Merge the ${count} source${count === 1 ? "" : "s"} below into ONE summary of about ${target} words (about ${Math.round((target / Math.max(totalWords, 1)) * 100)}% of the ${totalWords} words supplied; stay within 15% of ${target}).

Rules:
- Combine overlapping topics instead of summarizing each source in turn; remove duplicates; keep the core themes.
- Keep important numbers, names, dates and qualifications. Never add facts that are not in the sources. Give no advice.
- ${NOISE_RULES}
- Format: first line is a short descriptive title starting with "# ". Then "## " theme headings, each followed by "- " bullets (one point each). ${cite ? "Cite sources inline with their numbers, like [1] or [1][3]." : "Do not add citations or source numbers."} No sources list, preamble or closing remarks. Write in the language of the sources.
${visualNote}
Sources:
${body}`;
}

function refinePrompt(summary: string, target: number): string {
  return `Rewrite the summary below to about ${target} words (±10%). Keep the same structure (title line starting with "# ", "## " headings, "- " bullets), any [n] citations, the key facts and the same language. Do not add new facts or any preamble.

${summary}`;
}

function parseBullets(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l));
  const bulletLines = lines.filter((l) => /^(?:[-*•]|\d+[.)])\s+/.test(l));
  const source = bulletLines.length >= 1 ? bulletLines : splitSentences(lines.join("\n\n")).map((s) => s.text);
  return source.map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, "").trim()).filter((l) => countWords(l) >= 3);
}

/* ---------------------------------------------------------------------------------------- */
/* Run                                                                                      */
/* ---------------------------------------------------------------------------------------- */

type Section = { id: string; sourceIndex: number; sourceName: string; title: string; text: string; pages?: string; visuals: Visual[]; words: number };

function buildSections(sources: PreparedSource[]): Section[] {
  const out: Section[] = [];
  sources.forEach((source, sourceIndex) => {
    if (source.chapters?.length) {
      for (const c of source.chapters) {
        const words = countWords(c.text);
        if (words < 8) continue;
        out.push({ id: `${source.id}:${c.id}`, sourceIndex, sourceName: source.name, title: c.title, text: c.text, ...(c.pages ? { pages: c.pages } : {}), visuals: c.visuals, words });
      }
    } else {
      out.push({ id: `${source.id}:all`, sourceIndex, sourceName: source.name, title: sources.length > 1 ? source.name : "Summary", text: source.text, visuals: [], words: countWords(source.text) });
    }
  });
  return out;
}

export function outlineToMarkdown(outline: SummarySection[], sources: { name: string }[]): string {
  const multi = sources.length > 1;
  const lines: string[] = [`# ${multi ? "Merged chapter summary" : (sources[0]?.name ?? "Summary").replace(/\.[a-z0-9]{2,4}$/i, "")}`, ""];
  let lastSource = -1;
  for (const section of outline) {
    if (multi && section.sourceIndex !== lastSource) {
      lines.push(`## ${section.sourceName}`, "");
      lastSource = section.sourceIndex;
    }
    const level = multi ? "###" : "##";
    if (!(section.title === "Summary" && !multi)) lines.push(`${level} ${section.title}${section.pages ? `  (${section.pages})` : ""}`);
    if (section.failed) lines.push(`- ⚠ This section could not be summarized (${section.failed}).`);
    else for (const b of section.bullets) lines.push(`- ${b}`);
    if (section.visuals.length) {
      lines.push("", "**Tables & figures:**");
      for (const v of section.visuals) lines.push(`- ${v.caption}${v.page ? ` (p. ${v.page})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function runSummary(input: RunInput): Promise<RunResult> {
  const { engine, sources, ratio, signal, onProgress } = input;
  const chapterMode = input.byChapter && sources.some((s) => s.chapters?.length);
  const sections = chapterMode ? buildSections(sources) : [];
  const inputWords = chapterMode ? sections.reduce((n, s) => n + s.words, 0) : sources.reduce((n, s) => n + countWords(s.text), 0);
  const notes: string[] = [];
  const cite = sources.length > 1;

  /* ---------- chapter-by-chapter ---------- */
  if (chapterMode) {
    const targets = sections.map((s) => Math.min(s.words, Math.max(Math.round(s.words * ratio), MIN_SECTION_TARGET)));
    const targetWords = targets.reduce((a, b) => a + b, 0);
    if (targetWords > Math.round(inputWords * ratio) * 1.25 + 20) notes.push(`Short chapters get at least ~${MIN_SECTION_TARGET} words each, so the total is a little above ${Math.round(ratio * 100)}%.`);
    const outline: SummarySection[] = [];
    let requests = 0;
    let failures = 0;
    let firstError: unknown;

    for (let i = 0; i < sections.length; i += 1) {
      checkAborted(signal);
      const section = sections[i]!;
      const target = targets[i]!;
      onProgress(`${section.title.length > 42 ? `${section.title.slice(0, 42)}…` : section.title} (${i + 1} of ${sections.length})`, (i / sections.length) * 0.97);
      const base = { id: section.id, sourceName: section.sourceName, sourceIndex: section.sourceIndex, title: section.title, ...(section.pages ? { pages: section.pages } : {}), visuals: section.visuals };
      try {
        let bullets: string[];
        if (engine.kind === "offline") {
          if (i % 2 === 0) await tick();
          bullets = summarizeOffline([{ id: section.id, name: section.title, text: section.text }], { ratio, targetWords: target, format: "bullets", citations: false }).bullets;
        } else {
          const { provider, key, model } = engine;
          const limit = PROVIDERS[provider].chunkWords;
          const ask = async (prompt: string) => {
            requests += 1;
            return complete(provider, key, model, prompt, { signal });
          };
          if (section.words <= limit) bullets = parseBullets(await ask(sectionPrompt(section.title, section.text, target)));
          else {
            const chunks = chunkSources([{ name: section.title, text: section.text }], limit);
            const partTarget = Math.max(MIN_SECTION_TARGET, Math.ceil((target * 1.5) / chunks.length));
            const partials: string[] = [];
            for (let c = 0; c < chunks.length; c += 1) partials.push(await ask(sectionPrompt(section.title, renderPieces(chunks[c]!.pieces, false), partTarget, { index: c + 1, total: chunks.length })));
            bullets = parseBullets(await ask(mergeBulletsPrompt(section.title, partials.join("\n"), target)));
          }
        }
        if (!bullets.length) throw new ProviderError("empty", "no usable text came back");
        outline.push({ ...base, bullets });
      } catch (error) {
        if (error instanceof ProviderError && (error.kind === "aborted" || error.kind === "auth" || error.kind === "permission" || error.kind === "notfound")) throw error;
        failures += 1;
        firstError ??= error;
        outline.push({ ...base, bullets: [], failed: error instanceof Error ? error.message.slice(0, 120) : "unknown error" });
      }
    }
    if (failures === sections.length) throw firstError ?? new ProviderError("empty", "No section could be summarized.");
    if (failures) notes.push(`${failures} section${failures === 1 ? "" : "s"} could not be summarized and ${failures === 1 ? "is" : "are"} marked in the result. Tap Regenerate to try again.`);
    if (engine.kind === "offline") notes.push("On-device mode picks the most important sentences of each chapter; it cannot rephrase. An AI provider gives smoother bullets.");
    else notes.push(`Each chapter was summarized separately (${requests} requests).`);
    const text = outlineToMarkdown(outline, sources) + (sources.length > 1 ? sourcesSection(sources) : "");
    const bodyWords = outline.reduce((n, s) => n + s.bullets.reduce((m, b) => m + countWords(b), 0), 0);
    onProgress("Done", 1);
    return { text, outline, engineLabel: engine.kind === "offline" ? "On-device (no key)" : `${PROVIDERS[engine.provider].short} · ${engine.model}`, inputWords, targetWords, outputWords: bodyWords, requests, notes };
  }

  /* ---------- merged by theme (no chapters) ---------- */
  const flat = sources.map((s) => ({ id: s.id, name: s.name, text: s.chapters?.length ? s.chapters.map((c) => c.text).join("\n\n") : s.text }));
  const flatWords = flat.reduce((n, s) => n + countWords(s.text), 0);
  const targetWords = Math.min(flatWords, Math.max(Math.round(flatWords * ratio), MIN_TARGET));
  if (Math.round(flatWords * ratio) < MIN_TARGET && flatWords > MIN_TARGET) notes.push(`The input is short, so a ${MIN_TARGET}-word minimum was used instead of exactly ${Math.round(ratio * 100)}%.`);

  if (engine.kind === "offline") {
    onProgress("Selecting key sentences on this device", 0.1);
    await tick();
    checkAborted(signal);
    const result = summarizeOffline(flat, { ratio, format: "themes", citations: cite, onProgress: (f) => onProgress("Selecting key sentences on this device", 0.1 + f * 0.85) });
    notes.push("On-device mode selects and groups the most representative sentences. It cannot rephrase; choose an AI provider for a smoother rewrite.");
    const text = deduplicateLines(result.text) + (cite ? sourcesSection(flat) : "");
    return { text, engineLabel: "On-device (no key)", inputWords: flatWords, targetWords: result.targetWords, outputWords: result.outputWords, requests: 0, notes };
  }

  const { provider, key, model } = engine;
  const limit = PROVIDERS[provider].chunkWords;
  const ask = (prompt: string) => complete(provider, key, model, prompt, { signal });
  let requests = 0;
  let chunks = chunkSources(flat, limit);
  let body: string;
  if (chunks.length <= 1) body = renderPieces(chunks[0]?.pieces ?? [], cite);
  else {
    notes.push(`Long input: split into ${chunks.length} parts to stay within ${PROVIDERS[provider].short} request limits.`);
    let level = 0;
    while (chunks.length > 1 && level < 4) {
      const partTarget = Math.max(80, Math.ceil((targetWords * 1.6) / chunks.length), Math.ceil(limit * ratio * 1.2));
      const summaries: string[] = [];
      for (let i = 0; i < chunks.length; i += 1) {
        checkAborted(signal);
        onProgress(`Summarizing part ${i + 1} of ${chunks.length}${level ? ` (round ${level + 1})` : ""}`, (i / (chunks.length + 1)) * 0.85);
        summaries.push(await ask(sectionPrompt("this part", renderPieces(chunks[i]!.pieces, cite), partTarget, { index: i + 1, total: chunks.length })));
        requests += 1;
      }
      chunks = chunkSources([{ name: "Condensed parts", text: summaries.join("\n\n") }], limit);
      level += 1;
    }
    body = renderPieces(chunks.flatMap((c) => c.pieces), false);
  }

  checkAborted(signal);
  onProgress("Merging into one summary", 0.88);
  let text = stripSources(await ask(mergedPrompt(body, targetWords, flatWords, flat.length, cite, input.keptVisuals)));
  requests += 1;
  const measured = measureSummaryWords(text);
  if (targetWords >= 40 && (measured > targetWords * 1.35 || measured < targetWords * 0.65)) {
    try {
      checkAborted(signal);
      onProgress("Adjusting length", 0.95);
      const refined = stripSources(await ask(refinePrompt(text, targetWords)));
      requests += 1;
      if (Math.abs(measureSummaryWords(refined) - targetWords) < Math.abs(measured - targetWords)) text = refined;
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "aborted") throw error;
      notes.push("The length adjustment step failed, so the first draft is shown.");
    }
  }
  const cleaned = deduplicateLines(text) + (cite ? sourcesSection(flat) : "");
  onProgress("Done", 1);
  return { text: cleaned, engineLabel: `${PROVIDERS[provider].short} · ${model}`, inputWords: flatWords, targetWords, outputWords: measureSummaryWords(cleaned), requests, notes };
}
