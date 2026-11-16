import { PALETTES, type PaletteId } from "./theme";
import { countWords } from "./text";
import type { SummarySection } from "./pipeline";

export type SlideSpec = { kind: "title" | "content" | "sources" | "visual"; heading: string; bullets: string[]; kicker?: string; image?: string; imgW?: number; imgH?: number };

function sentences(paragraph: string): string[] {
  return (paragraph.match(/[^.!?]+(?:[.!?]+(?:\s*\[\d+(?:[,\s]*\d+)*\])*|$)/g) ?? [paragraph]).map((s) => s.trim()).filter((s) => countWords(s) > 2);
}

/** Turn the summary (title, optional ## sections, paragraphs/bullets) into slide specs. */
function planFromOutline(outline: SummarySection[], title: string, inputWords: number, outputWords: number): SlideSpec[] {
  const slides: SlideSpec[] = [{ kind: "title", heading: title, bullets: [`${outline.length} section${outline.length === 1 ? "" : "s"} · ${inputWords.toLocaleString()} words condensed to ${outputWords.toLocaleString()}`] }];
  outline.forEach((section, n) => {
    const kicker = String(n + 1).padStart(2, "0");
    let group: string[] = [];
    let words = 0;
    let part = 0;
    const emit = () => {
      if (!group.length) return;
      part += 1;
      slides.push({ kind: "content", heading: part > 1 ? `${section.title} (cont.)` : section.title, bullets: group, kicker });
      group = [];
      words = 0;
    };
    for (const bullet of section.bullets) {
      const w = countWords(bullet);
      if (group.length >= 5 || (group.length && words + w > 90)) emit();
      group.push(bullet);
      words += w;
    }
    emit();
    const captionOnly = section.visuals.filter((v) => !v.image);
    for (const v of section.visuals.filter((x) => x.image)) {
      slides.push({ kind: "visual", heading: v.caption, bullets: [], kicker: `${section.title}${v.page ? ` · page ${v.page}` : ""}`, ...(v.image ? { image: v.image } : {}), ...(v.width ? { imgW: v.width } : {}), ...(v.height ? { imgH: v.height } : {}) });
    }
    if (captionOnly.length) slides.push({ kind: "content", heading: `Tables & figures — ${section.title}`, bullets: captionOnly.slice(0, 6).map((v) => `${v.caption}${v.page ? ` (p. ${v.page})` : ""}`), kicker });
  });
  return slides;
}

export function planSlides(summary: string, inputWords: number, outputWords: number, outline?: SummarySection[]): SlideSpec[] {
  if (outline?.length) {
    const heading = summary.split("\n").find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, "").trim() || "Chapter summary";
    return planFromOutline(outline.filter((s) => !s.failed), heading, inputWords, outputWords);
  }
  const [body = "", sourcesText = ""] = summary.split(/\n#{1,3}\s*Sources\b[^\n]*\n/i);
  const lines = body.split("\n");
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, "").trim() || "Merged summary";
  const sourceNames = sourcesText.split("\n").map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);

  type Section = { heading: string; bullets: string[] };
  const sections: Section[] = [];
  let current: Section = { heading: "", bullets: [] };
  const flush = () => {
    if (current.bullets.length) sections.push(current);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^#\s+/.test(line)) continue;
    if (/^##+\s+/.test(line)) {
      flush();
      current = { heading: line.replace(/^#+\s+/, ""), bullets: [] };
    } else if (/^[-*•]\s+/.test(line)) current.bullets.push(line.replace(/^[-*•]\s+/, ""));
    else current.bullets.push(...sentences(line));
  }
  flush();

  const slides: SlideSpec[] = [{ kind: "title", heading: title, bullets: [`Merged from ${sourceNames.length || "several"} source${sourceNames.length === 1 ? "" : "s"} · ${inputWords.toLocaleString()} words condensed to ${outputWords.toLocaleString()}`] }];
  let part = 0;
  for (const section of sections) {
    // At most 5 bullets / ~90 words per slide.
    let group: string[] = [];
    let words = 0;
    const emit = () => {
      if (!group.length) return;
      part += 1;
      slides.push({ kind: "content", heading: section.heading || `Key points ${part}`, bullets: group, kicker: String(part).padStart(2, "0") });
      group = [];
      words = 0;
    };
    for (const bullet of section.bullets) {
      const w = countWords(bullet);
      if (group.length >= 5 || (group.length && words + w > 90)) emit();
      group.push(bullet);
      words += w;
    }
    emit();
  }
  if (sourceNames.length) slides.push({ kind: "sources", heading: "Sources", bullets: sourceNames.map((n, i) => `[${i + 1}] ${n}`) });
  return slides;
}

export async function buildPptx(slides: SlideSpec[], paletteId: PaletteId): Promise<Blob> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const colors = (PALETTES.find((p) => p.id === paletteId) ?? PALETTES[0]!).pptx;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = slides[0]?.heading ?? "Merged summary";
  pptx.author = "Briefly";
  const font = "Calibri";

  slides.forEach((spec, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: colors.bg };
    if (spec.kind === "title") {
      slide.addShape("rect", { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: colors.accent }, line: { color: colors.accent } });
      slide.addText(spec.heading, { x: 0.9, y: 2.2, w: 11.4, h: 1.8, fontFace: font, fontSize: 38, bold: true, color: colors.ink, valign: "bottom", fit: "shrink" });
      slide.addText(spec.bullets[0] ?? "", { x: 0.9, y: 4.25, w: 11.4, h: 0.6, fontFace: font, fontSize: 16, color: colors.soft });
      return;
    }
    slide.addShape("rect", { x: 0, y: 0, w: 13.333, h: 0.18, fill: { color: colors.ink }, line: { color: colors.ink } });
    if (spec.kind === "visual" && spec.image) {
      slide.addText(spec.kicker ?? "", { x: 0.6, y: 0.3, w: 12, h: 0.3, fontFace: font, fontSize: 11, color: colors.soft });
      slide.addText(spec.heading, { x: 0.6, y: 0.6, w: 12.1, h: 0.7, fontFace: font, fontSize: 20, bold: true, color: colors.ink, fit: "shrink" });
      const ratio = spec.imgW && spec.imgH ? spec.imgW / spec.imgH : 0.72;
      const maxH = 5.9;
      const maxW = 12.1;
      const h = Math.min(maxH, maxW / ratio);
      const w = h * ratio;
      slide.addImage({ data: spec.image, x: (13.333 - w) / 2, y: 1.4, w, h });
      slide.addText(String(index + 1), { x: 12.2, y: 7.1, w: 0.7, h: 0.3, fontFace: font, fontSize: 10, color: colors.soft, align: "right" });
      return;
    }
    if (spec.kicker) slide.addText(`KEY IDEA ${spec.kicker}`, { x: 0.8, y: 0.5, w: 6, h: 0.3, fontFace: font, fontSize: 12, bold: true, color: colors.accent, charSpacing: 2 });
    slide.addText(spec.heading, { x: 0.8, y: 0.85, w: 11.7, h: 0.9, fontFace: font, fontSize: 28, bold: true, color: colors.ink, fit: "shrink" });
    const small = spec.bullets.length > 4 || spec.kind === "sources";
    slide.addText(
      spec.bullets.map((text) => ({ text, options: { bullet: spec.kind === "sources" ? false : { indent: 18 }, breakLine: true, paraSpaceAfter: 12 } })),
      { x: 0.9, y: 1.95, w: 11.5, h: 4.9, fontFace: font, fontSize: small ? 18 : 21, color: colors.ink, valign: "top", fit: "shrink" },
    );
    slide.addText(String(index + 1), { x: 12.2, y: 6.95, w: 0.7, h: 0.3, fontFace: font, fontSize: 10, color: colors.soft, align: "right" });
  });
  const out = await pptx.write({ outputType: "blob" });
  return out as Blob;
}
