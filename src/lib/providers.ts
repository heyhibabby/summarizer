/**
 * Direct-from-browser AI providers (bring-your-own-key). No proxy, no shared secret.
 * Every call goes straight from this page to the provider the user selected.
 */

export type ProviderId = "google" | "openai" | "anthropic" | "openrouter" | "groq";
export const PROVIDER_IDS: ProviderId[] = ["google", "openai", "anthropic", "openrouter", "groq"];

export type ProviderInfo = {
  label: string;
  short: string;
  keyUrl: string;
  keyExample: string;
  howTo: string;
  cost: string;
  note: string;
  /** Max words of source text per request (conservative; keeps requests under typical limits). */
  chunkWords: number;
  /** Does the provider offer a free tier for personal keys (subject to change)? */
  freeTier: boolean;
};

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  google: {
    label: "Google Gemini",
    short: "Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyExample: "AIza…",
    howTo: "Open Google AI Studio, sign in, choose “Create API key”, and paste it here.",
    cost: "Has a free tier with daily limits; paid use is billed per token. Limits vary by account and region.",
    note: "Google calls direct-from-browser use a prototyping setup. Use a key you can revoke.",
    chunkWords: 40_000,
    freeTier: true,
  },
  openai: {
    label: "OpenAI",
    short: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyExample: "sk-…",
    howTo: "Create a project API key on the OpenAI platform. API billing is separate from a ChatGPT subscription and needs credit on the account.",
    cost: "Billed per token; the account needs prepaid credit.",
    note: "OpenAI advises against browser-side keys. Use a dedicated, limited key and revoke it if shared.",
    chunkWords: 25_000,
    freeTier: false,
  },
  anthropic: {
    label: "Anthropic Claude",
    short: "Claude",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyExample: "sk-ant-…",
    howTo: "Create an API key in the Anthropic Console. API billing is separate from a Claude.ai subscription and needs credit.",
    cost: "Billed per token; needs credit on the account.",
    note: "Browser access is enabled with Anthropic’s explicit direct-browser header. Use a dedicated key.",
    chunkWords: 40_000,
    freeTier: false,
  },
  openrouter: {
    label: "OpenRouter",
    short: "OpenRouter",
    keyUrl: "https://openrouter.ai/keys",
    keyExample: "sk-or-…",
    howTo: "Create a key on OpenRouter. One key reaches many models; some are free, others need credit.",
    cost: "Pay per model; several models are free but rate-limited.",
    note: "Model prices, availability and limits vary by model.",
    chunkWords: 15_000,
    freeTier: true,
  },
  groq: {
    label: "Groq",
    short: "Groq",
    keyUrl: "https://console.groq.com/keys",
    keyExample: "gsk_…",
    howTo: "Create an API key in the Groq Console.",
    cost: "Has a free tier with small per-minute token limits, so long documents are split into small parts.",
    note: "Free-tier rate limits are strict; large batches may need several minutes.",
    chunkWords: 3_500,
    freeTier: true,
  },
};

export type ModelInfo = { id: string; name: string };

export type ProviderErrorKind = "auth" | "permission" | "quota" | "notfound" | "badrequest" | "network" | "server" | "empty" | "aborted";

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status: number | undefined;
  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

/** Strip whitespace, quotes, "Bearer ", and invisible/non-ASCII characters that break HTTP headers. */
export function sanitizeKey(raw: string): string {
  const quotes = /^["'`“”‘’]+|["'`“”‘’]+$/g;
  return raw
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, " ")
    .trim()
    .replace(quotes, "")
    .trim()
    .replace(/^(?:authorization:\s*)?bearer\s+/i, "")
    .replace(quotes, "")
    .replace(/[^\x21-\x7E]/g, "");
}

export function detectProvider(key: string): ProviderId | null {
  const k = sanitizeKey(key);
  if (/^AIza[\w-]{20,}$/.test(k)) return "google";
  if (/^sk-ant-/i.test(k)) return "anthropic";
  if (/^sk-or-/i.test(k)) return "openrouter";
  if (/^gsk_/i.test(k)) return "groq";
  if (/^sk-/i.test(k)) return "openai";
  return null;
}

export function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "••••";
}

const BASE: Record<ProviderId, string> = {
  google: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
};

function authHeaders(provider: ProviderId, key: string): Record<string, string> {
  switch (provider) {
    case "google":
      return { "x-goog-api-key": key };
    case "anthropic":
      return { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    default:
      return { Authorization: `Bearer ${key}` };
  }
}

async function readProviderMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof json.error === "string" ? json.error : (json.error?.message ?? json.message);
    if (message) return message.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 200);
}

async function toError(response: Response): Promise<ProviderError> {
  const status = response.status;
  const detail = await readProviderMessage(response);
  const invalidKey = /api key not valid|invalid api key|incorrect api key|invalid x-api-key|invalid_api_key|authentication/i.test(detail);
  if (status === 401 || invalidKey) return new ProviderError("auth", `The provider rejected this key (HTTP ${status}). ${detail}`.trim(), status);
  if (status === 403) return new ProviderError("permission", `This key is not allowed to use that model or API (HTTP 403). ${detail}`.trim(), status);
  if (status === 429) return new ProviderError("quota", `Rate limit or quota reached (HTTP 429). ${detail}`.trim(), status);
  if (status === 404) return new ProviderError("notfound", `That model or endpoint is not available to this key (HTTP 404). ${detail}`.trim(), status);
  if (status === 400 || status === 413 || status === 422) return new ProviderError("badrequest", `The provider could not process the request (HTTP ${status}). ${detail}`.trim(), status);
  return new ProviderError("server", `The provider had a problem (HTTP ${status}). ${detail}`.trim(), status);
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ProviderError("aborted", "Stopped.");
    const message = error instanceof Error ? error.message : "";
    if (/ISO-8859-1|header|Invalid character/i.test(message)) {
      throw new ProviderError("auth", "The key contains characters that cannot be sent. Re-copy it from the provider’s page, without spaces or line breaks.");
    }
    throw new ProviderError("network", "The browser could not reach the provider. This is usually a connection problem, a content blocker, or the provider blocking browser requests (CORS).");
  }
}

const sortByName = (a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name);

export async function listModels(provider: ProviderId, key: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const init: RequestInit = { headers: authHeaders(provider, key), ...(signal ? { signal } : {}) };

  if (provider === "google") {
    const out: ModelInfo[] = [];
    let pageToken = "";
    for (let page = 0; page < 5; page += 1) {
      const response = await request(`${BASE.google}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, init);
      if (!response.ok) throw await toError(response);
      const data = (await response.json()) as { models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string };
      for (const model of data.models ?? []) {
        const id = model.name?.replace(/^models\//, "") ?? "";
        if (!id || !model.supportedGenerationMethods?.includes("generateContent")) continue;
        if (!/^gemini|^gemma/i.test(id) || /embedding|tts|image|veo|imagen|aqa|live|audio|robotics|computer-use|learnlm/i.test(id)) continue;
        out.push({ id, name: model.displayName ? `${model.displayName} (${id})` : id });
      }
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return out.sort(sortByName);
  }

  if (provider === "anthropic") {
    const response = await request(`${BASE.anthropic}/models?limit=100`, init);
    if (!response.ok) throw await toError(response);
    const data = (await response.json()) as { data?: { id: string; display_name?: string }[] };
    return (data.data ?? []).map((m) => ({ id: m.id, name: m.display_name ? `${m.display_name} (${m.id})` : m.id }));
  }

  if (provider === "openrouter") {
    // /models is public, so validate the key separately — otherwise a bad key would look fine.
    const check = await request(`${BASE.openrouter}/auth/key`, init);
    if (!check.ok) throw await toError(check);
    const response = await request(`${BASE.openrouter}/models`, init);
    if (!response.ok) throw await toError(response);
    const data = (await response.json()) as { data?: { id: string; name?: string; pricing?: { prompt?: string; completion?: string }; architecture?: { output_modalities?: string[]; modality?: string } }[] };
    return (data.data ?? [])
      .filter((m) => (m.architecture?.output_modalities ? m.architecture.output_modalities.length === 1 && m.architecture.output_modalities[0] === "text" : !/image/i.test(m.architecture?.modality?.split("->")[1] ?? "")))
      .map((m) => {
        const free = m.id.endsWith(":free") || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
        return { id: m.id, name: `${m.name ?? m.id}${free ? " · free" : ""}` };
      })
      .sort(sortByName);
  }

  // OpenAI + Groq (OpenAI-compatible)
  const response = await request(`${BASE[provider]}/models`, init);
  if (!response.ok) throw await toError(response);
  const data = (await response.json()) as { data?: { id: string }[] };
  const ids = (data.data ?? []).map((m) => m.id);
  const keep =
    provider === "openai"
      ? ids.filter((id) => /^(gpt-|o\d|chatgpt)/i.test(id) && !/audio|realtime|transcribe|tts|image|embedding|moderation|search|instruct|codex|diffusion|dall|whisper|computer-use/i.test(id))
      : ids.filter((id) => !/whisper|tts|guard|playai|distil-whisper|orpheus|embedding|moderation/i.test(id));
  return keep.sort().map((id) => ({ id, name: id }));
}

const PREFERRED: Record<ProviderId, RegExp[]> = {
  google: [/^gemini-2\.5-flash$/, /^gemini-flash-latest$/, /^gemini-2\.0-flash$/, /flash/],
  openai: [/^gpt-4\.1-mini$/, /^gpt-4o-mini$/, /^gpt-5-mini$/, /mini/],
  anthropic: [/haiku/, /sonnet/],
  openrouter: [/free/, /flash/, /mini|haiku/],
  groq: [/^llama-3\.3-70b-versatile$/, /^llama-3\.1-8b-instant$/, /llama/],
};

export function pickDefaultModel(provider: ProviderId, models: ModelInfo[]): string {
  for (const pattern of PREFERRED[provider]) {
    const match = models.find((m) => pattern.test(m.id));
    if (match) return match.id;
  }
  return models[0]?.id ?? "";
}

type CompleteOptions = { signal?: AbortSignal; maxRetries?: number };

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ProviderError("aborted", "Stopped."));
    }, { once: true });
  });

async function completeOnce(provider: ProviderId, key: string, model: string, prompt: string, signal?: AbortSignal): Promise<{ text: string; retryAfter?: number }> {
  const headers = { "Content-Type": "application/json", ...authHeaders(provider, key) };
  let url: string;
  let body: unknown;
  if (provider === "google") {
    url = `${BASE.google}/models/${encodeURIComponent(model)}:generateContent`;
    body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } };
  } else if (provider === "anthropic") {
    url = `${BASE.anthropic}/messages`;
    body = { model, max_tokens: 8192, temperature: 0.2, messages: [{ role: "user", content: prompt }] };
  } else {
    url = `${BASE[provider]}/chat/completions`;
    // No temperature for OpenAI/OpenRouter: newer reasoning models reject non-default values.
    body = provider === "groq" ? { model, temperature: 0.2, messages: [{ role: "user", content: prompt }] } : { model, messages: [{ role: "user", content: prompt }] };
  }
  const response = await request(url, { method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const error = await toError(response);
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) (error as ProviderError & { retryAfter?: number }).retryAfter = retryAfter;
    throw error;
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string | { type?: string; text?: string }[] | null }; finish_reason?: string }[];
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    content?: { type?: string; text?: string }[];
  };
  let text = "";
  if (provider === "google") {
    if (data.promptFeedback?.blockReason) throw new ProviderError("badrequest", `Gemini blocked this request (${data.promptFeedback.blockReason}). Try excluding the flagged source.`);
    text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
  } else if (provider === "anthropic") {
    text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  } else {
    const content = data.choices?.[0]?.message?.content;
    text = Array.isArray(content) ? content.map((c) => c.text ?? "").join("\n") : (content ?? "");
  }
  if (!text.trim()) throw new ProviderError("empty", "The model returned no text. Pick another model for this provider and try again.");
  return { text: text.trim() };
}

/** One completion with automatic retry for rate limits and transient server errors. */
export async function complete(provider: ProviderId, key: string, model: string, prompt: string, options: CompleteOptions = {}): Promise<string> {
  const retries = options.maxRetries ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await completeOnce(provider, key, model, prompt, options.signal)).text;
    } catch (error) {
      const retryable = error instanceof ProviderError && (error.kind === "quota" || (error.kind === "server" && (error.status ?? 500) >= 500));
      if (!retryable || attempt >= retries) throw error;
      const hinted = (error as ProviderError & { retryAfter?: number }).retryAfter;
      await delay(Math.min(hinted ? hinted * 1000 : 2500 * 2 ** attempt, 30_000), options.signal);
    }
  }
}

/** Plain-language message for any error thrown while talking to a provider. */
export function describeError(error: unknown, provider?: ProviderId, key?: string): string {
  if (error instanceof ProviderError) {
    if (error.kind === "aborted") return "Stopped. Your sources are still here.";
    const detected = key ? detectProvider(key) : null;
    if (error.kind === "auth" && provider && detected && detected !== provider) {
      return `That looks like a ${PROVIDERS[detected].label} key, but ${PROVIDERS[provider].label} is selected. Switch provider to ${PROVIDERS[detected].short}.`;
    }
    if (error.kind === "auth") return `${error.message} Check that the key is complete, active and created for ${provider ? PROVIDERS[provider].label : "this provider"}.`;
    if (error.kind === "quota") return `${error.message} Wait a minute, try another model, or check the plan and billing with the provider.`;
    return error.message;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "Stopped. Your sources are still here.";
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
