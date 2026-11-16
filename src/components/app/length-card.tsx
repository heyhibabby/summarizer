import { BookCopy, SlidersHorizontal } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/app/info-tip";
import { cn } from "@/lib/utils";

type Props = {
  ratio: number;
  onRatio: (ratio: number) => void;
  inputWords: number;
  targetWords: number;
  hasChapters: boolean;
  byChapter: boolean;
  onByChapter: (value: boolean) => void;
  hasPdf: boolean;
  snapshots: boolean;
  onSnapshots: (value: boolean) => void;
};

const PRESETS = [3, 5, 10, 20, 35];

export function LengthCard({ ratio, onRatio, inputWords, targetWords, hasChapters, byChapter, onByChapter, hasPdf, snapshots, onSnapshots }: Props) {
  const percent = Math.round(ratio * 100);
  return (
    <section aria-label="Summary length" className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-1">
        <SlidersHorizontal className="size-4 text-primary" />
        <h2 className="text-sm font-semibold">How much to keep</h2>
        <InfoTip label="About summary length">
          <p>Choose what share of the original length the summary should have, from 1% to 50%. In chapter mode every chapter is shortened by the same share, so long chapters get more points than short ones.</p>
          <p>It is a target: readability comes first, and very short chapters get a small minimum.</p>
        </InfoTip>
        <span className="ml-auto rounded-full bg-primary px-3 py-1 font-mono text-sm font-semibold tabular-nums text-primary-foreground">{percent}%</span>
      </div>
      <Slider min={1} max={50} step={1} value={[percent]} onValueChange={([v]) => onRatio((v ?? 5) / 100)} aria-label="Percent of the original to keep" className="py-2" />
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Quick lengths">
        {PRESETS.map((p) => (
          <button key={p} type="button" onClick={() => onRatio(p / 100)} className={cn("h-9 min-w-12 rounded-full border px-3 text-xs font-semibold transition-colors", percent === p ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary")}>{p}%</button>
        ))}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{inputWords > 0 ? <><span className="font-mono font-semibold text-foreground">{inputWords.toLocaleString()}</span> words → about <span className="font-mono font-semibold text-foreground">{targetWords.toLocaleString()}</span> words</> : "Add a source to see the target length."}</p>

      {(hasChapters || hasPdf) && (
        <div className="mt-3 space-y-2.5 border-t border-border pt-3">
          {hasChapters && (
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={byChapter} onCheckedChange={onByChapter} aria-label="Summarize chapter by chapter" />
              <span className="flex items-start gap-1.5"><BookCopy className="mt-0.5 size-4 shrink-0 text-primary" /><span>Summarize chapter by chapter<span className="block text-xs text-muted-foreground">{byChapter ? "Key points per chapter, with its tables & figures." : "One merged summary grouped by theme."}</span></span></span>
            </label>
          )}
          {hasPdf && byChapter && (
            <label className="flex items-start gap-3 text-sm">
              <Switch checked={snapshots} onCheckedChange={onSnapshots} aria-label="Include page snapshots of tables and figures" />
              <span>Show page snapshots of tables &amp; figures<span className="block text-xs text-muted-foreground">Adds a picture of the PDF page next to each chapter’s tables and charts.</span></span>
            </label>
          )}
        </div>
      )}
    </section>
  );
}
