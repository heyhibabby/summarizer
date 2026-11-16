import { summarizeOffline } from "./extractive";
import { complete, PROVIDERS, ProviderError, type ProviderId } from "./providers";
import { countWords, measureSummaryWords } from "./text";
import { deduplicateLines } from "./summarizer";

export type PreparedSource = { id: string; name: string; text: string };
export type VisualNote = { kind: string; sourceName: string; excerpt: string };

export type Engine =
  | { kind: "offline" }
  | { kind: "ai"; provider: ProviderId; key: string; model: string };

export type RunInput = {
  engine: Engine;
  sources: PreparedSource[];
  ratio: number;
  keptVisuals: VisualNote[];
  signal: AbortSignal;
  onProgress: (label: string, fraction: number) => void;
};

export type RunResult = {
  text: string;
  engineLabel: string;
  inputWords: number;
  targetWords: number;
  outputWords: number;
  requests: number;
  notes: string[];
};

const MIN_TARGET = 25;

export function sourcesSection(sources: PreparedSource[]): string {
  return `\n\n## Sources\n${sources.map((s, i) => `${i + 1}. ${s.name}`).join("\n")}`;
}

/** Remove any Sources list the model added itself so we can append ours exactly once. */
function stripSources(text: string): string {
  return text.replace(/\n+#{1,3}\s*Sources?\b[\s\S]*$/i, "").replace(/\n+\*{0,2}Sources?:?\*{0,2}\s*\n(?:\s*(?:[-*]|\d+[.)])\s.*\n?)+$/i, "").trim();
}

type Piece = { n: number; name: string; text: string; words: number };
export type Chunk = { pieces: Piece[]; words: number };

/** Split sources into chunks of at most `limit` words, breaking on paragraph boundaries. */
export function chunkSources(sources: PreparedSource[], limit: number): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk = { pieces: [], words: 0 };
  const flush = () => {
    if (current.pieces.length) chunks.push(current);
    current = { pieces: [], words: 0 };
  };
  sources.forEach((source, index) => {
    const paragraphs = source.text.split(/\n{2,}/).flatMap((p) => {
      // Break up giant paragraphs (e.g. PDFs with no blank lines) so a chunk can never exceed the limit.
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
      if (current.words + bufferWords + words > limit && (current.words + bufferWords) > 0) {
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

function renderPieces(pieces: Piece[]): string {
  return pieces.map((p) => `[SOURCE ${p.n}: ${p.name}]\n${p.text}`).join("\n\n");
}

const FORMAT_RULES = `Format: first line is a short descriptive title starting with "# ". Then either one or two short paragraphs, or "## " section headings (only when the sources contain clearly distinct themes) each followed by a paragraph or "- " bullets. Cite sources inline with their numbers, like [1] or [1][3]. Do not add a sources list, preamble, or closing remarks. Write in the language of the sources.`;

function finalPrompt(body: string, target: number, totalWords: number, count: number, visuals: VisualNote[]): string {
  const visualNote = visuals.length
    ? `\nThe reader chose to keep these references to visual elements (you only see their text, not the visuals — do not describe what they show):\n${visuals.map((v) => `- [${v.kind}] ${v.sourceName}: ${v.excerpt}`).join("\n")}\n`
    : "";
  return `You are a careful summarizer. Merge the ${count} numbered source${count === 1 ? "" : "s"} below into ONE summary of about ${target} words (about ${Math.round((target / Math.max(totalWords, 1)) * 100)}% of the ${totalWords} words supplied; stay within 15% of ${target}).

Rules:
- Combine overlapping topics instead of summarizing each source in turn; remove duplicate or near-duplicate statements; keep the core theme.
- Keep important numbers, names, dates and qualifications. Never add facts that are not in the sources. Do not give advice.
- ${FORMAT_RULES}
${visualNote}
Sources:
${body}`;
}

function partPrompt(body: string, target: number, index: number, total: number): string {
  return `Summarize part ${index} of ${total} of a longer document set in about ${target} words. Keep key facts, numbers, names and qualifications; drop repetition and filler. Keep the [SOURCE n] numbers by citing like [n] after each statement. Output plain paragraphs only — no title, no preamble. Write in the language of the text.

${body}`;
}

function refinePrompt(summary: string, target: number): string {
  return `Rewrite the summary below to about ${target} words (±10%). Keep the same structure (title line starting with "# ", optional "## " headings), the [n] citations, the key facts and the same language. Do not add new facts or any preamble.

${summary}`;
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderError("aborted", "Stopped.");
}

export async function runSummary(input: RunInput): Promise<RunResult> {
  const { engine, sources, ratio, signal, onProgress } = input;
  const inputWords = sources.reduce((sum, s) => sum + countWords(s.text), 0);
  const targetWords = Math.min(inputWords, Math.max(Math.round(inputWords * ratio), MIN_TARGET));
  const notes: string[] = [];
  if (Math.round(inputWords * ratio) < MIN_TARGET && inputWords > MIN_TARGET) notes.push(`The input is short, so a ${MIN_TARGET}-word minimum was used instead of exactly ${Math.round(ratio * 100)}%.`);

  if (engine.kind === "offline") {
    onProgress("Selecting key sentences on this device", 0.1);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the UI paint before the CPU-heavy part
    checkAborted(signal);
    const result = summarizeOffline(sources, { ratio, onProgress: (f) => onProgress("Selecting key sentences on this device", 0.1 + f * 0.85) });
    const text = deduplicateLines(result.text) + sourcesSection(sources);
    notes.push("On-device mode selects and groups the most representative sentences from your sources. It cannot rephrase; choose an AI provider for a smoother rewrite.");
    return { text, engineLabel: "On-device (no key)", inputWords, targetWords: result.targetWords, outputWords: result.outputWords, requests: 0, notes };
  }

  const { provider, key, model } = engine;
  const limit = PROVIDERS[provider].chunkWords;
  const ask = (prompt: string) => complete(provider, key, model, prompt, { signal });
  let requests = 0;

  let chunks = chunkSources(sources, limit);
  let body: string;
  if (chunks.length <= 1) {
    body = renderPieces(chunks[0]?.pieces ?? []);
  } else {
    // Map: condense each part. Reduce: repeat until everything fits in one request.
    notes.push(`Long input: split into ${chunks.length} parts to stay within ${PROVIDERS[provider].short} request limits.`);
    let level = 0;
    while (chunks.length > 1 && level < 4) {
      const partTarget = Math.max(80, Math.ceil((targetWords * 1.6) / chunks.length), Math.ceil(limit * ratio * 1.2));
      const summaries: string[] = [];
      for (let i = 0; i < chunks.length; i += 1) {
        checkAborted(signal);
        onProgress(`Summarizing part ${i + 1} of ${chunks.length}${level ? ` (round ${level + 1})` : ""}`, (i / (chunks.length + 1)) * 0.85);
        summaries.push(await ask(partPrompt(renderPieces(chunks[i]!.pieces), partTarget, i + 1, chunks.length)));
        requests += 1;
      }
      const merged: PreparedSource[] = [{ id: "parts", name: "Condensed parts", text: summaries.join("\n\n") }];
      chunks = chunkSources(merged, limit);
      level += 1;
    }
    body = renderPieces(chunks.flatMap((c) => c.pieces).map((p) => ({ ...p, name: p.n === 1 && sources.length > 1 ? "Condensed parts (citations [n] refer to the original sources)" : p.name })));
  }

  checkAborted(signal);
  onProgress("Merging into one summary", 0.88);
  let text = stripSources(await ask(finalPrompt(body, targetWords, inputWords, sources.length, input.keptVisuals)));
  requests += 1;

  const measured = measureSummaryWords(text);
  if (targetWords >= 40 && (measured > targetWords * 1.35 || measured < targetWords * 0.65)) {
    try {
      checkAborted(signal);
      onProgress("Adjusting length", 0.95);
      const refined = stripSources(await ask(refinePrompt(text, targetWords)));
      requests += 1;
      const refinedWords = measureSummaryWords(refined);
      if (Math.abs(refinedWords - targetWords) < Math.abs(measured - targetWords)) text = refined;
    } catch (error) {
      if (error instanceof ProviderError && error.kind === "aborted") throw error;
      notes.push("The length adjustment step failed, so the first draft is shown.");
    }
  }

  const cleaned = deduplicateLines(text) + sourcesSection(sources);
  onProgress("Done", 1);
  return { text: cleaned, engineLabel: `${PROVIDERS[provider].short} · ${model}`, inputWords, targetWords, outputWords: measureSummaryWords(cleaned), requests, notes };
}
