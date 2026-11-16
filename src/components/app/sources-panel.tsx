import { useRef, useState, type DragEvent } from "react";
import { AlertTriangle, BookOpenText, ChevronDown, ClipboardPaste, FlaskConical, Link2, ListTree, LoaderCircle, Plus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { InfoTip } from "@/components/app/info-tip";
import { ACCEPTED_FILES, MAX_SOURCES } from "@/lib/extract";
import { countWords, type SourceRecord } from "@/lib/summarizer";
import { SPLIT_LABELS, type SplitChoice } from "@/lib/chapters";
import { cn } from "@/lib/utils";

type Props = {
  sources: SourceRecord[];
  included: (id: string) => boolean;
  flagged: Set<string>;
  keywords: Record<string, string[]>;
  busy: boolean;
  busyLabel: string;
  onFiles: (files: File[]) => void;
  onPaste: (text: string) => void;
  onUrl: (url: string, viaReader: boolean) => Promise<boolean>;
  onSample: () => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, included: boolean) => void;
  onFinding: (sourceId: string, findingId: string, included: boolean) => void;
  onChapter: (sourceId: string, chapterId: string, included: boolean) => void;
  onAllChapters: (sourceId: string, included: boolean) => void;
  onSplit: (sourceId: string, choice: SplitChoice) => void;
  onStop: () => void;
};

export function SourcesPanel({ sources, included, flagged, keywords, busy, busyLabel, onFiles, onPaste, onUrl, onSample, onRemove, onToggle, onFinding, onChapter, onAllChapters, onSplit, onStop }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"" | "paste" | "url">("");
  const [pasted, setPasted] = useState("");
  const [url, setUrl] = useState("");
  const [viaReader, setViaReader] = useState(false);
  const [dragging, setDragging] = useState(false);
  const full = sources.length >= MAX_SOURCES;

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (full || busy) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) onFiles(files);
  };

  return (
    <section aria-label="Sources" className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <h2 className="font-serif text-2xl font-semibold">Sources</h2>
          <InfoTip label="About sources">
            <p>Add up to {MAX_SOURCES} items: PDF, Word (.docx), text, Markdown, pasted text, or a public article link.</p>
            <p>Files are read on this device. Scanned PDFs, images and charts are not read as pictures — only their text is.</p>
          </InfoTip>
        </div>
        <span className="rounded-full bg-secondary px-2.5 py-1 font-mono text-xs tabular-nums text-muted-foreground">{sources.length} / {MAX_SOURCES}</span>
      </div>

      <input ref={fileRef} type="file" accept={ACCEPTED_FILES} multiple className="sr-only" aria-label="Choose files" onChange={(event) => { if (event.target.files?.length) onFiles(Array.from(event.target.files)); event.target.value = ""; }} />

      <div
        onDragOver={(event) => { event.preventDefault(); if (!full) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn("rounded-2xl border-2 border-dashed p-3 transition-colors", dragging ? "border-primary bg-primary/5" : "border-border")}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Button className="h-12 flex-col gap-0.5 sm:h-14" disabled={busy || full} onClick={() => fileRef.current?.click()}><Upload className="size-5" /><span className="text-xs">Upload files</span></Button>
          <Button variant="outline" className="h-12 flex-col gap-0.5 sm:h-14" disabled={full} onClick={() => setMode(mode === "paste" ? "" : "paste")}><ClipboardPaste className="size-5" /><span className="text-xs">Paste text</span></Button>
          <Button variant="outline" className="h-12 flex-col gap-0.5 sm:h-14" disabled={full} onClick={() => setMode(mode === "url" ? "" : "url")}><Link2 className="size-5" /><span className="text-xs">Article link</span></Button>
          <Button variant="outline" className="h-12 flex-col gap-0.5 sm:h-14" disabled={busy || sources.length > 2} onClick={onSample}><FlaskConical className="size-5" /><span className="text-xs">Try samples</span></Button>
        </div>
        <p className="mt-2 hidden text-center text-xs text-muted-foreground sm:block">…or drag files here</p>

        {mode === "paste" && (
          <div className="mt-3 space-y-2 border-t border-border pt-3">
            <label htmlFor="paste-box" className="text-sm font-medium">Paste text</label>
            <Textarea id="paste-box" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste an article, notes or any text…" className="min-h-36 text-base" />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{countWords(pasted).toLocaleString()} words</span>
              <Button disabled={countWords(pasted) < 5} onClick={() => { onPaste(pasted); setPasted(""); setMode(""); }}><Plus />Add text</Button>
            </div>
          </div>
        )}

        {mode === "url" && (
          <form className="mt-3 space-y-2 border-t border-border pt-3" onSubmit={async (event) => { event.preventDefault(); if (await onUrl(url, viaReader)) { setUrl(""); setMode(""); } }}>
            <label htmlFor="article-url" className="flex items-center gap-1 text-sm font-medium">Article link<InfoTip label="About article links"><p>Many sites block reading from a browser (CORS). If this fails, paste the text instead.</p><p>The optional reader service can fetch such pages, but then the link is sent to that third-party service (r.jina.ai).</p></InfoTip></label>
            <div className="flex gap-2">
              <Input id="article-url" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" className="h-11 text-base" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
              <Button type="submit" className="h-11" disabled={!url.trim() || busy}>{busy ? <LoaderCircle className="animate-spin" /> : null}Add</Button>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch checked={viaReader} onCheckedChange={setViaReader} aria-label="Use reader service" />Use a third-party reader service if the site blocks direct reading</label>
          </form>
        )}
      </div>

      {busy && (
        <div className="flex items-center gap-3 rounded-xl bg-secondary/60 px-4 py-3 text-sm" role="status">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
          <span className="min-w-0 flex-1 truncate">{busyLabel}</span>
          <Button variant="ghost" size="sm" onClick={onStop}>Stop</Button>
        </div>
      )}

      {sources.length === 0 && !busy && (
        <div className="rounded-2xl bg-secondary/50 px-5 py-8 text-center">
          <BookOpenText className="mx-auto mb-2 size-8 text-muted-foreground" />
          <p className="font-medium">Nothing added yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Upload a PDF, paste some text, or tap <strong>Try samples</strong> to see how it works — no key needed.</p>
        </div>
      )}

      <ul className="space-y-2.5">
        {sources.map((source, index) => (
          <SourceCard key={source.id} index={index} source={source} included={included(source.id)} flagged={flagged.has(source.id)} keywords={keywords[source.id] ?? []} onRemove={() => onRemove(source.id)} onToggle={(v) => onToggle(source.id, v)} onFinding={(fid, v) => onFinding(source.id, fid, v)} onChapter={(cid, v) => onChapter(source.id, cid, v)} onAllChapters={(v) => onAllChapters(source.id, v)} onSplit={(c) => onSplit(source.id, c)} />
        ))}
      </ul>
    </section>
  );
}

function SourceCard({ source, index, included, flagged, keywords, onRemove, onToggle, onFinding, onChapter, onAllChapters, onSplit }: { source: SourceRecord; index: number; included: boolean; flagged: boolean; keywords: string[]; onRemove: () => void; onToggle: (included: boolean) => void; onFinding: (findingId: string, included: boolean) => void; onChapter: (chapterId: string, included: boolean) => void; onAllChapters: (included: boolean) => void; onSplit: (choice: SplitChoice) => void }) {
  const [open, setOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const chapters = source.chapters ?? [];
  const usedChapters = chapters.filter((c) => c.included).length;
  return (
    <li className={cn("rounded-2xl border bg-card p-3.5 shadow-sm transition-opacity", flagged && included ? "border-accent/60" : "border-border", !included && "opacity-60")}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary font-mono text-xs font-semibold text-primary">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={source.name}>{source.name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">{source.kind}</span>
            <span>{countWords(source.text).toLocaleString()} words</span>
            {source.findings.length > 0 && <span>· {source.findings.length} visual mention{source.findings.length === 1 ? "" : "s"}</span>}
          </p>
          {keywords.length > 0 && <p className="mt-1.5 flex flex-wrap gap-1">{keywords.slice(0, 4).map((k) => <span key={k} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{k}</span>)}</p>}
          {flagged && <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-accent"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />Different topic from most sources — {included ? "included by you" : "excluded"}.</p>}
          {source.note && <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{source.note}</p>}
        </div>
        <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label={`Remove ${source.name}`} onClick={onRemove}><X className="size-4" /></Button>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5">
        <label className="flex items-center gap-2 text-sm"><Switch checked={included} onCheckedChange={onToggle} aria-label={`Include ${source.name}`} />Include in summary</label>
        <span className="flex">
          {chapters.length > 0 && <Button variant="ghost" size="sm" onClick={() => setChaptersOpen((v) => !v)} aria-expanded={chaptersOpen}><ListTree />{usedChapters}/{chapters.length} chapters<ChevronDown className={cn("transition-transform", chaptersOpen && "rotate-180")} /></Button>}
          {source.findings.length > 0 && <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>Visuals<ChevronDown className={cn("transition-transform", open && "rotate-180")} /></Button>}
        </span>
      </div>
      {chaptersOpen && chapters.length > 0 && (
        <div className="mt-2 border-t border-border pt-3">
          {source.layout && (
            <div className="mb-3">
              <label htmlFor={`split-${source.id}`} className="mb-1 flex items-center gap-1 text-xs font-semibold">Split into sections by<InfoTip label="About splitting"><p>If the sections look wrong, pick another way to split the document. “Every N pages” always works, even when the book has no clear headings.</p></InfoTip></label>
              <div className="relative">
                <select id={`split-${source.id}`} value={source.split ?? "auto"} onChange={(e) => onSplit(e.target.value as SplitChoice)} className="h-11 w-full appearance-none rounded-md border border-input bg-background px-3 pr-10 text-base">
                  {(Object.keys(SPLIT_LABELS) as SplitChoice[]).filter((k) => source.kind === "PDF" || k === "auto" || k === "headings").map((k) => <option key={k} value={k}>{SPLIT_LABELS[k]}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-3.5 size-4 text-muted-foreground" />
              </div>
            </div>
          )}
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Untick front matter, index or anything you don’t want summarized.</p>
            <span className="flex shrink-0 gap-1"><Button variant="outline" size="sm" className="h-8" onClick={() => onAllChapters(true)}>All</Button><Button variant="outline" size="sm" className="h-8" onClick={() => onAllChapters(false)}>None</Button></span>
          </div>
          <ul className="max-h-72 divide-y divide-border overflow-auto rounded-lg border border-border">
            {chapters.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 text-sm">
                  <Checkbox className="mt-0.5" checked={c.included} onCheckedChange={(v) => onChapter(c.id, v === true)} />
                  <span className="min-w-0 flex-1"><span className="block break-words leading-snug">{c.title}</span><span className="text-[11px] text-muted-foreground">{countWords(c.text).toLocaleString()} words{c.startPage ? ` · p. ${c.startPage}${c.endPage && c.endPage !== c.startPage ? `–${c.endPage}` : ""}` : ""}</span></span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && (
        <ul className="mt-2 space-y-2 border-t border-border pt-3">
          {source.findings.map((f) => (
            <li key={f.id}>
              <label className="flex items-start gap-2.5 text-xs leading-5">
                <Checkbox className="mt-0.5" checked={f.included} onCheckedChange={(c) => onFinding(f.id, c === true)} />
                <span><span className="font-semibold capitalize">{f.kind}</span> · {f.excerpt}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
