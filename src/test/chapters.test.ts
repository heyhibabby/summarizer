import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChapters, chaptersFromText } from "@/lib/chapters";
import { makeSource } from "@/lib/extract";
import { runSummary, outlineToMarkdown, type PreparedSource } from "@/lib/pipeline";
import { chapterVisuals } from "@/lib/visuals";
import { isCrossReference, isUsableSentence, normalizeExtracted, splitSentences } from "@/lib/text";

const filler = (topic: string, n = 12) =>
  Array.from({ length: n }, (_, i) => `The ${topic} behaves differently when the mixture temperature changes during stage ${i}, so producers monitor it carefully in every batch.`).join(" ");
afterEach(() => vi.unstubAllGlobals());

describe("chapter detection", () => {
  it("finds Markdown headings", () => {
    const text = `# Water\n\n${filler("water")}\n\n# Sugars\n\n${filler("sugar")}\n\n# Fats\n\n${filler("fat")}`;
    const r = chaptersFromText(text);
    expect(r.method).toBe("headings");
    expect(r.chapters.map((c) => c.title)).toEqual(["Water", "Sugars", "Fats"]);
  });
  it("finds 'Chapter N' lines and skips contents / index by default", () => {
    const text = [`Contents\n${filler("toc", 5)}`, `Chapter 1 Freezing\n${filler("freezing")}`, `Chapter 2 Sweeteners\n${filler("sweetener")}`, `Chapter 3 Gums\n${filler("gum")}`].join("\n\n");
    const r = buildChapters(text.split("\n").map((t) => ({ text: t })));
    expect(r.chapters.filter((c) => c.included).map((c) => c.title)).toEqual(["Chapter 1 — Freezing", "Chapter 2 — Sweeteners", "Chapter 3 — Gums"]);
    const idx = chaptersFromText(`# Intro\n\n${filler("a")}\n\n# Index\n\n${filler("b")}\n\n# Body\n\n${filler("c")}`);
    expect(idx.chapters.find((c) => c.title === "Index")?.included).toBe(false);
  });
  it("does not invent chapters for a short plain article", () => {
    const src = makeSource("Note", "Pasted text", filler("note", 20));
    expect(src.chapters).toBeUndefined();
  });
  it("splits very long unstructured text into parts", () => {
    const long = Array.from({ length: 30 }, () => filler("part", 18)).join("\n\n");
    const src = makeSource("Long", "Text", long);
    expect(src.chapters && src.chapters.length).toBeGreaterThan(2);
  });
});

describe("sentence quality", () => {
  it("drops cross-references, fragments and cut-off sentences", () => {
    for (const bad of [
      "In the following pages, we will continue to use the absolute PAC for predictions.",
      "See Table 12 on the next page for the full list of values here.",
      "mixture freeze (increases absolute PAC) when the sugars are added together.",
      "Careful measurement of temperature and overrun gives",
      "Calculate the absolute PAC using Equations 33-8 and 33-9 as we report below:",
    ]) expect(isUsableSentence(bad), bad).toBe(false);
    expect(isCrossReference("Table 3 lists the PAC of each sugar.")).toBe(false);
    expect(isUsableSentence("Increasing the inulin content raises the antifreeze power, so the ice cream becomes softer.")).toBe(true);
  });
  it("turns symbol-font bullets into separate statements", () => {
    const fixed = normalizeExtracted("Two rules apply: ÿ raise solids to firm the mix; ÿ lower water to firm the mix.");
    expect(fixed).not.toMatch(/ÿ/);
    expect(splitSentences(fixed).length).toBeGreaterThanOrEqual(2);
  });
});

describe("visuals per chapter", () => {
  it("assigns captions by page range and avoids double counting", () => {
    const src = makeSource("b.pdf", "PDF", "x", "", [
      { id: "", kind: "table", label: "Table", excerpt: "Table 1-1: Sugars", included: true, remove: "Table 1-1: Sugars", page: 3 },
      { id: "", kind: "chart", label: "Chart", excerpt: "Figure 1-1: Crystals", included: true, remove: "Figure 1-1: Crystals", page: 4 },
      { id: "", kind: "image", label: "Embedded image", excerpt: "Page 4: 1 embedded image", included: true, remove: "", page: 4 },
      { id: "", kind: "table", label: "Table", excerpt: "Table 2-1: Gums", included: true, remove: "Table 2-1: Gums", page: 6 },
    ]);
    const ch1 = { id: "c1", title: "One", text: "Table 1-1: Sugars\nFigure 1-1: Crystals", startPage: 3, endPage: 4, included: true };
    const ch2 = { id: "c2", title: "Two", text: "Table 2-1: Gums", startPage: 5, endPage: 7, included: true };
    const taken = new Set<string>();
    const v1 = chapterVisuals(src, ch1, taken);
    const v2 = chapterVisuals(src, ch2, taken);
    expect(v1.map((v) => v.caption)).toEqual(["Table 1-1: Sugars", "Figure 1-1: Crystals"]); // bare image on a captioned page is folded in
    expect(v2.map((v) => v.caption)).toEqual(["Table 2-1: Gums"]);
  });
});

describe("chapter-by-chapter pipeline", () => {
  const prepared = (): PreparedSource[] => [{ id: "s", name: "Book.pdf", text: "", chapters: ["Water", "Sugars", "Fats"].map((t, i) => ({ id: `c${i}`, title: t, text: filler(t.toLowerCase(), 30), pages: `p. ${i * 3 + 1}–${i * 3 + 3}`, visuals: [] })) }];
  const base = { ratio: 0.1, byChapter: true, keptVisuals: [], onProgress: () => {} };

  it("on-device: one section per chapter, bullets, no [n] tags", async () => {
    const r = await runSummary({ ...base, engine: { kind: "offline" }, sources: prepared(), signal: new AbortController().signal });
    expect(r.outline!.map((s) => s.title)).toEqual(["Water", "Sugars", "Fats"]);
    expect(r.outline!.every((s) => s.bullets.length >= 1)).toBe(true);
    expect(r.text).not.toMatch(/\[\d+\]/);
    expect(r.text).toMatch(/## Water/);
  });
  it("AI: one request per chapter; a failed chapter is marked, not fatal", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n += 1;
      if (n === 2) return new Response(JSON.stringify({ error: { message: "bad input" } }), { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "- First point about the chapter here.\n- Second point with more detail." } }] }), { status: 200 });
    }));
    const r = await runSummary({ ...base, engine: { kind: "ai", provider: "openai", key: "sk-x", model: "m" }, sources: prepared(), signal: new AbortController().signal });
    expect(r.outline!.map((s) => !!s.failed)).toEqual([false, true, false]);
    expect(r.notes.join(" ")).toMatch(/1 section could not be summarized/);
    expect(outlineToMarkdown(r.outline!, [{ name: "Book.pdf" }])).toMatch(/could not be summarized/);
  });
  it("AI: a rejected key stops the whole run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })));
    await expect(runSummary({ ...base, engine: { kind: "ai", provider: "openai", key: "sk-x", model: "m" }, sources: prepared(), signal: new AbortController().signal })).rejects.toMatchObject({ kind: "auth" });
  });
});
