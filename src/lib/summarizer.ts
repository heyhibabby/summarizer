export type SourceRecord = {
  id: string;
  name: string;
  kind: "PDF" | "Text" | "Markdown" | "Pasted text" | "Article";
  text: string;
  status: "ready" | "error";
  note?: string;
  findings: Finding[];
};

export type Finding = {
  id: string;
  kind: "image" | "table" | "chart";
  label: string;
  excerpt: string;
  included: boolean;
};

const stopWords = new Set(
  "about after again all also and are because been before being between both but can could did does each for from had has have here how into its just more most not our out over same should some such than that the their them then there these they this those through under was were what when where which while who will with would you your a an as at by do if in is it of on or to we".split(
    " ",
  ),
);

export function countWords(text: string): number {
  return text.trim().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function targetWordCount(inputWords: number): number {
  return Math.max(1, Math.round(inputWords * 0.05));
}

function topicTerms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(words.filter((word) => !stopWords.has(word)));
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function findTopicOutliers(sources: Pick<SourceRecord, "id" | "text">[]): string[] {
  if (sources.length < 2) return [];
  const terms = sources.map((source) => topicTerms(source.text));
  const scores = terms.map((sourceTerms, index) => {
    const others = terms.filter((_, otherIndex) => otherIndex !== index);
    return others.reduce((sum, other) => sum + similarity(sourceTerms, other), 0) / others.length;
  });
  const typical = [...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)] ?? 0;
  const lowBar = Math.max(0.08, typical * 0.45);
  return sources.filter((_, index) => (scores[index] ?? 0) < lowBar).map((source) => source.id);
}

const findingPatterns: { kind: Finding["kind"]; pattern: RegExp }[] = [
  { kind: "table", pattern: /\b(table|tabular data|rows and columns)\b/i },
  { kind: "chart", pattern: /\b(chart|graph|figure|trend line|bar graph|pie chart)\b/i },
  { kind: "image", pattern: /\b(image|photograph|illustration|screenshot|diagram)\b/i },
];

export function findReviewFindings(text: string): Finding[] {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const findings: Finding[] = [];
  for (const line of lines) {
    const match = findingPatterns.find(({ pattern }) => pattern.test(line));
    if (!match) continue;
    const excerpt = line.slice(0, 240);
    if (findings.some((finding) => finding.kind === match.kind && finding.excerpt === excerpt)) continue;
    findings.push({
      id: `${match.kind}-${findings.length}-${excerpt.length}`,
      kind: match.kind,
      label: `${match.kind[0]?.toUpperCase() ?? ""}${match.kind.slice(1)} reference`,
      excerpt,
      included: true,
    });
  }
  return findings;
}

export function textWithoutExcludedFindings(source: SourceRecord): string {
  const excluded = source.findings.filter((finding) => !finding.included).map((finding) => finding.excerpt);
  return excluded.reduce((text, excerpt) => text.replace(excerpt, ""), source.text).trim();
}

export function deduplicateLines(text: string): string {
  const seen = new Set<string>();
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const key = line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n");
}

export type ProviderId = "google" | "openai" | "openrouter";

export const providerDetails: Record<ProviderId, { label: string; base: string; keyHelp: string; limitation: string }> = {
  google: {
    label: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    keyHelp: "Create a Gemini API key in Google AI Studio. Use a key restricted to Gemini API; model access and free/paid quotas vary by account and region.",
    limitation: "Google describes direct browser Gemini calls as prototyping; do not use this for an enterprise or sensitive-data workflow.",
  },
  openai: {
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    keyHelp: "Create a project API key in the OpenAI platform. API billing is separate from ChatGPT and follows the model’s token pricing and project limits.",
    limitation: "OpenAI advises against putting standard API keys in browsers. Direct browser access may be blocked or restricted; use only a dedicated, limited key and stop if the browser blocks it.",
  },
  openrouter: {
    label: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    keyHelp: "Create an OpenRouter API key. Model prices, provider availability, and limits vary; check the selected model’s page and account limits.",
    limitation: "Direct browser access depends on provider CORS behavior. This app never routes around a blocked request or switches providers silently.",
  },
};

type ProviderModel = { id: string; name: string };

export async function listProviderModels(provider: ProviderId, apiKey: string, signal?: AbortSignal): Promise<ProviderModel[]> {
  const headers: HeadersInit = provider === "google" ? {} : { Authorization: `Bearer ${apiKey}` };
  const endpoint = provider === "google"
    ? `${providerDetails.google.base}/models?key=${encodeURIComponent(apiKey)}`
    : `${providerDetails[provider].base}/models`;
  const response = await fetch(endpoint, { headers, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(await providerError(response));
  const data = await response.json() as { data?: { id?: string }[]; models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
  if (provider === "google") {
    return (data.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent") && model.name)
      .map((model) => ({ id: model.name?.replace(/^models\//, "") ?? "", name: model.displayName ?? model.name?.replace(/^models\//, "") ?? "" }))
      .filter((model) => model.id && !/embedding|tts|image|veo/i.test(model.id));
  }
  return (data.data ?? []).map((model) => ({ id: model.id ?? "", name: model.id ?? "" })).filter((model) => model.id && !/embedding|audio|whisper|moderation|tts/i.test(model.id));
}

async function providerError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const status = response.status;
  if (status === 401 || status === 403) return `The provider rejected this key (${status}). Check the key and its access. No other provider was selected.`;
  if (status === 429) return "The provider rate limit or account quota was reached. Check your plan, usage, and billing with the selected provider.";
  if (status === 404) return "That model or endpoint is unavailable to this key. Choose a model shown by the provider and try again.";
  return `The provider returned ${status}. ${body.slice(0, 260)}`;
}

export async function requestCompletion(provider: ProviderId, apiKey: string, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  if (provider === "google") {
    response = await fetch(`${providerDetails.google.base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
      ...(signal ? { signal } : {}),
    });
  } else {
    response = await fetch(`${providerDetails[provider].base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
      ...(signal ? { signal } : {}),
    });
  }
  if (!response.ok) throw new Error(await providerError(response));
  const data = await response.json() as {
    choices?: { message?: { content?: string | { type: string; text?: string }[] } }[];
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const content = provider === "google"
    ? data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n")
    : data.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part.text ?? "").join("\n") : content;
  if (!text?.trim()) throw new Error("The selected model returned no readable text. Try another model from the same provider.");
  return text.trim();
}

export function friendlyNetworkError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Stopped. Your source files remain in this browser until you clear this session.";
  if (error instanceof TypeError) return "The browser could not reach this provider, often because of CORS or a network issue. This app does not use a proxy or switch providers. Try the same provider again or use a provider whose browser request is allowed.";
  return error instanceof Error ? error.message : "Something went wrong. Check your connection and try again.";
}