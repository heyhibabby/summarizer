import { useMemo, useState } from "react";
import { Check, Copy, Download, FileText, LoaderCircle, Presentation, RefreshCw, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SummaryView } from "@/components/app/summary-view";
import { InfoTip } from "@/components/app/info-tip";
import { buildPptx, planSlides } from "@/lib/pptx";
import { canShareFile, downloadBlob, shareFile } from "@/lib/download";
import { useTheme } from "@/lib/theme";
import type { RunResult } from "@/lib/pipeline";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function OutputPanel({ result, onRerun, rerunning }: { result: RunResult; onRerun: () => void; rerunning: boolean }) {
  const { palette } = useTheme();
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [building, setBuilding] = useState(false);
  const [file, setFile] = useState<{ blob: Blob; name: string } | null>(null);
  const [error, setError] = useState("");
  const slides = useMemo(() => planSlides(result.text, result.inputWords, result.outputWords), [result]);
  const off = result.targetWords > 0 && Math.abs(result.outputWords - result.targetWords) > Math.max(8, result.targetWords * 0.4);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy was blocked by the browser. Select the text and copy it manually.");
    }
  };

  const makePptx = async () => {
    setConfirm(false);
    setBuilding(true);
    setError("");
    try {
      const blob = await buildPptx(slides, palette);
      const typed = new Blob([blob], { type: PPTX });
      setFile({ blob: typed, name: "merged-summary.pptx" });
      downloadBlob(typed, "merged-summary.pptx");
    } catch (e) {
      setError(`The presentation could not be created: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <section aria-label="Summary" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex items-center gap-1">
          <h2 className="font-serif text-2xl font-semibold">Summary</h2>
          <InfoTip label="About this summary"><p>Made with <strong>{result.engineLabel}</strong>{result.requests ? ` in ${result.requests} request${result.requests === 1 ? "" : "s"}` : ""}.</p><p>Check important facts against your sources before relying on it.</p></InfoTip>
        </div>
        <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground"><span>{result.inputWords.toLocaleString()} in</span><span>→</span><span className="font-semibold text-foreground">{result.outputWords.toLocaleString()} out</span><span>(target ~{result.targetWords.toLocaleString()})</span></p>
      </div>

      {off && <p className="rounded-xl bg-accent/10 px-3.5 py-2.5 text-xs leading-5" role="status">The length differs noticeably from the target. Regenerate, or change the length slider and run again.</p>}
      {result.notes.map((n) => <p key={n} className="rounded-xl bg-secondary/60 px-3.5 py-2.5 text-xs leading-5 text-muted-foreground">{n}</p>)}

      <article className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-7"><SummaryView text={result.text} /></article>

      {error && <p role="alert" className="rounded-xl bg-destructive/10 px-3.5 py-2.5 text-xs leading-5">{error}</p>}

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button variant="outline" className="h-11" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
        <Button variant="outline" className="h-11" onClick={() => downloadBlob(new Blob([result.text], { type: "text/markdown;charset=utf-8" }), "merged-summary.md")}><Download />Markdown</Button>
        <Button variant="outline" className="h-11" onClick={() => downloadBlob(new Blob([result.text.replace(/^#+\s*/gm, "")], { type: "text/plain;charset=utf-8" }), "merged-summary.txt")}><FileText />Text</Button>
        <Button className="h-11" disabled={building} onClick={() => setConfirm(true)}>{building ? <LoaderCircle className="animate-spin" /> : <Presentation />}PowerPoint</Button>
        <Button variant="ghost" className="col-span-2 h-11 sm:col-span-1" disabled={rerunning} onClick={onRerun}><RefreshCw />Regenerate</Button>
      </div>

      {file && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-primary/10 px-3.5 py-2.5 text-xs" role="status">
          <Check className="size-4 text-primary" />PowerPoint created.
          <Button size="sm" variant="outline" onClick={() => downloadBlob(file.blob, file.name)}><Download />Download again</Button>
          {canShareFile(file.blob, file.name) && <Button size="sm" variant="outline" onClick={() => void shareFile(file.blob, file.name)}><Share2 />Save / Share</Button>}
        </div>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">Create a PowerPoint?</DialogTitle>
            <DialogDescription>{slides.length} slides will be built on this device from the summary above.</DialogDescription>
          </DialogHeader>
          <ol className="max-h-56 space-y-1 overflow-auto text-sm">
            {slides.map((s, i) => <li key={i} className="flex gap-2"><span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">{i + 1}</span><span className="truncate">{s.heading}</span></li>)}
          </ol>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setConfirm(false)}>Not now</Button>
            <Button onClick={() => void makePptx()}><Check />Create &amp; download</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
