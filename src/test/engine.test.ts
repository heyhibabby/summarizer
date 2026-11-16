import { describe, expect, it, vi } from "vitest";
import { summarizeOffline } from "@/lib/extractive";
import { chunkSources, runSummary } from "@/lib/pipeline";
import { analyzeTopics, findReviewFindings, textWithoutExcludedFindings } from "@/lib/summarizer";
import { measureSummaryWords } from "@/lib/text";

const topics = ["solar panels","wind turbines","coal plants","carbon pricing","sea levels","heatwaves","battery storage","grid investment","nuclear reactors","forest loss","methane leaks","electric vehicles","heat pumps","drought risk","flood defences","green hydrogen"];
const para = (i: number, tag = "study") => `Researchers studying ${topics[i % topics.length]} reported new findings in ${tag} ${i}. The analysis of ${topics[(i + 3) % topics.length]} showed measurable changes over ${i + 5} years across several regions. Officials responsible for ${topics[(i + 7) % topics.length]} said funding decisions in ${2000 + i} would shape long term outcomes.`;
const doc = (n: number, tag?: string) => Array.from({ length: n }, (_, i) => para(i, tag)).join("\n\n");
const bread = Array.from({ length: 20 }, (_, i) => `Sourdough bread needs a lively starter fed with flour and water on day ${i}. Long cold fermentation develops flavour while gluten builds structure. Bakers shape and proof the loaf before baking it with steam for a crisp crust.`).join("\n\n");

describe("on-device summarizer", () => {
  it("lands near the 5% target, cites sources, covers each source", () => {
    const r = summarizeOffline([{ id: "a", name: "A", text: doc(80) }, { id: "b", name: "B", text: doc(60, "trial") }], { ratio: 0.05 });
    expect(r.outputWords).toBeGreaterThan(r.targetWords * 0.75);
    expect(r.outputWords).toBeLessThan(r.targetWords * 1.2);
    expect(r.text).toMatch(/\[1\]/);
    expect(r.perSource["a"]).toBeGreaterThan(0);
    expect(r.perSource["b"]).toBeGreaterThan(0);
  });
  it("handles 160k words quickly", () => {
    const big = Array.from({ length: 5 }, (_, k) => ({ id: String(k), name: `S${k}`, text: doc(1200, `s${k}`) }));
    const t = Date.now();
    const r = summarizeOffline(big, { ratio: 0.05 });
    expect(Date.now() - t).toBeLessThan(15000);
    expect(r.outputWords).toBeGreaterThan(0);
  });
});

describe("topics & findings", () => {
  it("flags the off-topic source among three", () => {
    const a = analyzeTopics([{ id: "a", text: doc(30) }, { id: "b", text: doc(30, "trial") }, { id: "c", text: bread }]);
    expect(a.outliers).toEqual(["c"]);
  });
  it("two unrelated sources raise a pair warning", () => {
    expect(analyzeTopics([{ id: "a", text: doc(30) }, { id: "c", text: bread }]).pairWarning).toBe(true);
  });
  it("detects captions, tables, markdown images and removes excluded ones", () => {
    const text = "Intro sentence here.\nFigure 2: Growth by year\n| a | b |\n| 1 | 2 |\n![chart](x.png)\nSee Table 3 for details.";
    const f = findReviewFindings(text);
    expect(f.map((x) => x.kind).sort()).toEqual(["chart", "image", "table", "table"]);
    const src = { text, findings: f.map((x) => ({ ...x, included: x.kind !== "chart" })) };
    expect(textWithoutExcludedFindings(src)).not.toContain("Figure 2");
  });
});

describe("pipeline", () => {
  it("chunks long input under the limit", () => {
    const chunks = chunkSources([{ id: "a", name: "A", text: doc(300) }], 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.words).toBeLessThanOrEqual(2000);
  });
  it("AI path: long input → map/reduce calls, then one final merge, Sources appended once", async () => {
    const prompts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      prompts.push(body.messages[0].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: "# Title\n\nA merged statement [1]. Another [2].\n\n## Sources\n1. junk" } }] }), { status: 200 });
    }));
    const res = await runSummary({ engine: { kind: "ai", provider: "groq", key: "gsk_x", model: "m" }, sources: [{ id: "a", name: "A", text: doc(400) }, { id: "b", name: "B", text: doc(100) }], ratio: 0.05, keptVisuals: [], signal: new AbortController().signal, onProgress: () => {} });
    expect(res.requests).toBeGreaterThan(2);
    expect(prompts.some((p) => p.startsWith("Summarize part"))).toBe(true);
    expect((res.text.match(/## Sources/g) ?? []).length).toBe(1);
    expect(res.text).toContain("1. A");
    expect(measureSummaryWords(res.text)).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
