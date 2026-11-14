import { describe, expect, it } from "vitest";
import { findTopicOutliers, targetWordCount, type SourceRecord } from "@/lib/summarizer";

describe("combined summary requirements", () => {
  it("targets approximately five percent of all combined input words", () => {
    const combinedOriginalWords = 2_000;
    expect(targetWordCount(combinedOriginalWords)).toBe(100);
  });

  it("flags a clearly unrelated source when most source topics align", () => {
    const sources = [
      { id: "climate-1", text: "climate energy emissions warming renewable carbon policy environment" },
      { id: "climate-2", text: "climate emissions renewable energy carbon environment warming policy" },
      { id: "climate-3", text: "renewable carbon climate policy energy emissions warming environment" },
      { id: "baking", text: "bread baking sourdough flour yeast kitchen recipe dough oven pastry" },
    ] as Pick<SourceRecord, "id" | "text">[];
    expect(findTopicOutliers(sources)).toContain("baking");
  });
});