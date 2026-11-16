import { afterEach, describe, expect, it, vi } from "vitest";
import { complete, describeError, detectProvider, listModels, ProviderError, sanitizeKey } from "@/lib/providers";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
afterEach(() => vi.unstubAllGlobals());

describe("keys", () => {
  it("sanitizes pasted keys (spaces, quotes, zero-width, Bearer)", () => {
    expect(sanitizeKey('  "Bearer sk-abc123\u200b\u00a0"\n')).toBe("sk-abc123");
  });
  it("detects the provider from the key prefix", () => {
    expect(detectProvider("AIzaSyA1234567890abcdefghijk")).toBe("google");
    expect(detectProvider("sk-ant-api03-xyz")).toBe("anthropic");
    expect(detectProvider("sk-or-v1-xyz")).toBe("openrouter");
    expect(detectProvider("sk-proj-xyz")).toBe("openai");
    expect(detectProvider("gsk_abc")).toBe("groq");
    expect(detectProvider("hello")).toBeNull();
  });
});

describe("listModels", () => {
  it("Gemini: only generateContent chat models, key sent as header not URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ models: [
      { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    const models = await listModels("google", "AIzaKEY");
    expect(models.map((m) => m.id)).toEqual(["gemini-2.5-flash"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain("AIzaKEY");
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": "AIzaKEY" });
  });
  it("OpenAI: filters out non-chat models", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ data: [{ id: "gpt-4.1-mini" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "dall-e-3" }, { id: "o3" }, { id: "gpt-4o-audio-preview" }] })));
    expect((await listModels("openai", "sk-x")).map((m) => m.id)).toEqual(["gpt-4.1-mini", "o3"]);
  });
  it("401 becomes an auth error with a readable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: { message: "Incorrect API key provided" } }, 401)));
    await expect(listModels("openai", "sk-bad")).rejects.toMatchObject({ kind: "auth" });
  });
  it("Gemini 400 'API key not valid' is treated as auth", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: { message: "API key not valid. Please pass a valid API key." } }, 400)));
    await expect(listModels("google", "AIzaBAD")).rejects.toMatchObject({ kind: "auth" });
  });
  it("network failure is reported as network, not auth", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(listModels("groq", "gsk_x")).rejects.toMatchObject({ kind: "network" });
  });
  it("mismatched key gets a helpful hint", () => {
    const msg = describeError(new ProviderError("auth", "x", 401), "google", "sk-proj-abc");
    expect(msg).toMatch(/OpenAI key/);
  });
});

describe("complete", () => {
  it("OpenAI request has no temperature (reasoning models reject it)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ choices: [{ message: { content: "ok text" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await complete("openai", "sk-x", "gpt-5-mini", "hi")).toBe("ok text");
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).not.toHaveProperty("temperature");
  });
  it("Anthropic sends browser-access header and parses text blocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ content: [{ type: "text", text: "hello" }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await complete("anthropic", "sk-ant-x", "claude-haiku", "hi")).toBe("hello");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "anthropic-dangerous-direct-browser-access": "true" });
  });
  it("retries once on 429 then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { message: "slow down" } }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(json({ candidates: [{ content: { parts: [{ text: "done" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const p = complete("google", "AIza", "gemini-2.5-flash", "hi");
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe("done");
    vi.useRealTimers();
  });
});
