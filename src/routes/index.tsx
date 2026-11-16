import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, BookOpenText, Check, Cpu, LoaderCircle, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EnginePanel, engineSummary } from "@/components/app/engine-panel";
import { InfoTip } from "@/components/app/info-tip";
import { OutputPanel } from "@/components/app/output-panel";
import { ReviewPanel } from "@/components/app/review-panel";
import { SourcesPanel } from "@/components/app/sources-panel";
import { ThemeMenu } from "@/components/app/theme-menu";
import { SAMPLE_DOCS } from "@/components/app/samples";
import { useConnections } from "@/lib/connections";
import { fetchArticle, makeSource, MAX_SOURCES, readFiles } from "@/lib/extract";
import { runSummary, type Engine, type PreparedSource, type RunResult } from "@/lib/pipeline";
import { chapterVisuals, renderPdfPage } from "@/lib/visuals";
import { LengthCard } from "@/components/app/length-card";
import { describeError, ProviderError } from "@/lib/providers";
import { useSettings, type EngineChoice } from "@/lib/settings";
import { buildChapters, type SplitChoice } from "@/lib/chapters";
import { analyzeTopics, countWords, sourceBodyText, stripExcluded, targetWordCount, type SourceRecord } from "@/lib/summarizer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Briefly — merge & summarize documents" },
      { name: "description", content: "Merge up to five documents into one short summary. Works on-device with no key, or with your own AI provider key." },
      { property: "og:title", content: "Briefly — merge & summarize documents" },
      { property: "og:description", content: "Merge up to five documents into one short summary. Private by design." },
      { property: "og:type", content: "website" },
    ],
  }),
  component: Home,
});

function Home() {
  const { prefs, keys, hydrated, storageOk, setPrefs, setKey, setModel, clearAllKeys } = useSettings();
  const { connections, connect, forget, forgetAll } = useConnections({ hydrated, keys, prefs, setKey, setModel });

  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [engineOpen, setEngineOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [progress, setProgress] = useState(0);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [byChapter, setByChapter] = useState(true);
  const [snapshots, setSnapshots] = useState(true);
  const [snapStatus, setSnapStatus] = useState("");
  const snapAbort = useRef<AbortController | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const initialised = useRef(false);

  // Show the key/engine section at startup until an AI provider has been set up.
  useEffect(() => {
    if (!hydrated || initialised.current) return;
    initialised.current = true;
    setEngineOpen(prefs.engine === "offline" && Object.keys(keys).length === 0);
  }, [hydrated, prefs.engine, keys]);

  const topics = useMemo(() => analyzeTopics(sources), [sources]);
  const flagged = useMemo(() => new Set(topics.outliers), [topics]);
  const included = useCallback((id: string) => overrides[id] ?? !flagged.has(id), [overrides, flagged]);
  const active = useMemo(() => sources.filter((s) => s.status === "ready" && included(s.id)), [sources, included]);
  const inputWords = useMemo(() => active.reduce((sum, s) => sum + countWords(sourceBodyText(s)), 0), [active]);
  const hasChapters = active.some((s) => (s.chapters?.length ?? 0) > 0);
  const chapterMode = hasChapters && byChapter;
  const hasPdf = active.some((s) => s.file);
  const targetWords = targetWordCount(inputWords, prefs.ratio);
  const engine = engineSummary(prefs, keys, connections);

  const invalidate = () => {
    snapAbort.current?.abort();
    setSnapStatus("");
    setResult(null);
  };
  const patchSource = (id: string, fn: (s: SourceRecord) => SourceRecord) => {
    setSources((c) => c.map((s) => (s.id === id ? fn(s) : s)));
    invalidate();
  };

  const addSources = useCallback((next: SourceRecord[]) => {
    setSources((current) => {
      const room = Math.max(0, MAX_SOURCES - current.length);
      if (next.length > room) setNotice(`The batch holds ${MAX_SOURCES} sources, so ${next.length - room} item${next.length - room === 1 ? " was" : "s were"} not added.`);
      return [...current, ...next.slice(0, room)];
    });
    setResult(null);
  }, []);

  const startOperation = (label: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setBusyLabel(label);
    setError("");
    return controller;
  };
  const endOperation = (controller: AbortController) => {
    if (abortRef.current === controller) abortRef.current = null;
    setBusy(false);
    setBusyLabel("");
  };

  const onFiles = async (files: File[]) => {
    const room = MAX_SOURCES - sources.length;
    if (room <= 0) return setNotice("The batch is full. Remove a source first.");
    const controller = startOperation("Reading files");
    try {
      const { sources: read, failures } = await readFiles(files.slice(0, room), controller.signal, setBusyLabel);
      if (read.length) addSources(read);
      if (files.length > room) setNotice(`Only ${room} more source${room === 1 ? "" : "s"} fit, so the rest were skipped.`);
      if (failures.length) setError(failures.join("\n"));
    } catch (e) {
      setError(describeError(e));
    } finally {
      endOperation(controller);
    }
  };

  const onUrl = async (url: string, viaReader: boolean): Promise<boolean> => {
    const controller = startOperation("Reading the article");
    try {
      addSources([await fetchArticle(url, controller.signal, viaReader)]);
      return true;
    } catch (e) {
      const blocked = e instanceof TypeError;
      setError(blocked ? "This site does not allow reading from a browser. Paste the article text instead, or switch on the reader-service option (it sends the link to a third party)." : describeError(e));
      return false;
    } finally {
      endOperation(controller);
    }
  };

  const onSample = () => addSources(SAMPLE_DOCS.slice(0, MAX_SOURCES - sources.length).map((d) => makeSource(d.name, "Text", d.text)));

  const setEngine = (choice: EngineChoice) => {
    setPrefs({ engine: choice });
    setError("");
  };

  const onSplit = (id: string, choice: SplitChoice) => {
    const src = sources.find((x) => x.id === id);
    if (!src?.layout) return;
    const built = buildChapters(src.layout.lines, src.layout.outline, choice);
    if (built.chapters.length < 2) {
      setNotice("That option found no sections in this document. Try another one.");
      return;
    }
    patchSource(id, (current) => ({ ...current, chapters: built.chapters, chapterMethod: built.method, split: choice }));
    setNotice(`${built.chapters.length} sections found.`);
  };

  const attachSnapshots = async (res: RunResult, files: (File | undefined)[]) => {
    snapAbort.current?.abort();
    const controller = new AbortController();
    snapAbort.current = controller;
    const jobs: { sourceIndex: number; page: number }[] = [];
    for (const section of res.outline ?? []) {
      for (const v of section.visuals) {
        if (v.page && files[section.sourceIndex] && !jobs.some((j) => j.sourceIndex === section.sourceIndex && j.page === v.page)) jobs.push({ sourceIndex: section.sourceIndex, page: v.page });
      }
    }
    const list = jobs.slice(0, 40);
    for (let i = 0; i < list.length; i += 1) {
      if (controller.signal.aborted) return;
      const job = list[i]!;
      setSnapStatus(`Capturing tables & figures ${i + 1} of ${list.length}…`);
      const shot = await renderPdfPage(files[job.sourceIndex]!, job.page);
      if (controller.signal.aborted) return;
      if (!shot) continue;
      setResult((cur) => {
        if (!cur?.outline) return cur;
        return {
          ...cur,
          outline: cur.outline.map((sec) =>
            sec.sourceIndex !== job.sourceIndex
              ? sec
              : { ...sec, visuals: sec.visuals.map((v, idx, arr) => (v.page === job.page && !v.image && !arr.slice(0, idx).some((x) => x.page === job.page) ? { ...v, image: shot.image, width: shot.width, height: shot.height } : v)) },
          ),
        };
      });
    }
    if (!controller.signal.aborted) setSnapStatus("");
  };

  const summarize = async () => {
    if (!active.length) return setError("Include at least one source first.");
    if (!engine.ready) {
      setEngineOpen(true);
      return setError(prefs.engine === "offline" ? "" : `Finish setting up ${engine.label} first, or switch to On-device.`);
    }
    let runEngine: Engine = { kind: "offline" };
    if (prefs.engine !== "offline") {
      const key = keys[prefs.engine];
      const model = prefs.models[prefs.engine];
      if (!key || !model) return setEngineOpen(true);
      runEngine = { kind: "ai", provider: prefs.engine, key, model };
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setSummarizing(true);
    setProgress(0.02);
    setBusyLabel("Starting");
    setError("");
    setNotice("");
    setResult(null);
    try {
      const visuals = active
        .flatMap((s) => s.findings.filter((f) => f.included).map((f) => ({ kind: f.kind, sourceName: s.name, excerpt: f.excerpt })))
        .slice(0, 25);
      const prepared: PreparedSource[] = active.map((s) => {
        const taken = new Set<string>();
        const chapters = s.chapters?.filter((c) => c.included).map((c) => ({
          id: c.id,
          title: c.title,
          text: stripExcluded(c.text, s.findings),
          ...(c.startPage ? { pages: `p. ${c.startPage}${c.endPage && c.endPage !== c.startPage ? `–${c.endPage}` : ""}` } : {}),
          visuals: chapterVisuals(s, c, taken, 5),
        }));
        return { id: s.id, name: s.name, text: sourceBodyText(s), ...(chapters?.length ? { chapters } : {}) };
      });
      const res = await runSummary({
        engine: runEngine,
        sources: prepared,
        ratio: prefs.ratio,
        byChapter: chapterMode,
        keptVisuals: visuals,
        signal: controller.signal,
        onProgress: (label, fraction) => {
          setBusyLabel(label);
          setProgress(Math.max(0.02, fraction));
        },
      });
      setResult(res);
      if (res.outline && snapshots && active.some((x) => x.file)) void attachSnapshots(res, active.map((x) => x.file));
      window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } catch (e) {
      const stopped = e instanceof ProviderError && e.kind === "aborted";
      setError(stopped ? "Stopped. Your sources are still here." : describeError(e, prefs.engine === "offline" ? undefined : prefs.engine, prefs.engine === "offline" ? undefined : keys[prefs.engine]));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSummarizing(false);
      setBusyLabel("");
    }
  };

  const stop = () => abortRef.current?.abort();
  const clearSession = () => {
    abortRef.current?.abort();
    snapAbort.current?.abort();
    setSnapStatus("");
    setSources([]);
    setOverrides({});
    setResult(null);
    setError("");
    setNotice("Session cleared. Saved keys were not touched.");
  };

  const working = busy || summarizing;
  const canSummarize = active.length > 0 && !working;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-4 pb-40 sm:px-6">
        <header className="flex h-16 items-center justify-between">
          <a href="/" className="flex items-center gap-2.5" aria-label="Briefly home">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground"><BookOpenText className="size-5" /></span>
            <span className="font-serif text-2xl font-semibold tracking-tight">Briefly</span>
          </a>
          <div className="flex items-center">
            {sources.length > 0 && <Button variant="ghost" size="icon" className="size-10" aria-label="Clear session" title="Clear session" onClick={clearSession}><Trash2 /></Button>}
            <ThemeMenu />
            <InfoTip label="How Briefly handles your data">
              <p>Files and text stay in this browser. Nothing is uploaded to our servers — there are none.</p>
              <p>In AI mode, the text of the included sources is sent directly to the provider you chose. Review that provider’s privacy and pricing terms.</p>
              <p>Saved API keys live in this browser’s storage and are not encrypted.</p>
            </InfoTip>
          </div>
        </header>

        <div className="mb-5 mt-1">
          <h1 className="font-serif text-[28px] font-semibold leading-tight sm:text-4xl">Merge documents into one short summary.</h1>
          <p className="mt-2 max-w-2xl text-[15px] leading-6 text-muted-foreground">Add up to five PDFs, Word files, notes or articles. Briefly checks they’re on the same topic, removes repeats, and condenses everything to about {Math.round(prefs.ratio * 100)}% of the original length.</p>
        </div>

        <div className="space-y-4">
          <EnginePanel
            open={engineOpen}
            onOpenChange={setEngineOpen}
            prefs={prefs}
            keys={keys}
            storageOk={storageOk}
            connections={connections}
            onEngine={setEngine}
            onConnect={async (provider, key) => {
              const res = await connect(provider, key, { save: true });
              if (res.ok) setEngineOpen(false);
              return res;
            }}
            onModel={(provider, model) => setModel(provider, model)}
            onRemoveKey={(provider) => { setKey(provider, null); forget(provider); }}
            onPersist={(persist) => setPrefs({ persist })}
            onClearAll={() => { clearAllKeys(); forgetAll(); }}
          />

          <LengthCard
            ratio={prefs.ratio}
            onRatio={(ratio) => { setPrefs({ ratio }); invalidate(); }}
            inputWords={inputWords}
            targetWords={targetWords}
            hasChapters={hasChapters}
            byChapter={byChapter}
            onByChapter={(value) => { setByChapter(value); invalidate(); }}
            hasPdf={hasPdf}
            snapshots={snapshots}
            onSnapshots={(value) => { setSnapshots(value); invalidate(); }}
          />

          {notice && (
            <p role="status" className="flex items-start gap-2 rounded-xl border-l-4 border-primary bg-secondary/60 px-3.5 py-3 text-sm">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" /><span className="flex-1">{notice}</span>
              <button type="button" aria-label="Dismiss" className="-m-1 p-1" onClick={() => setNotice("")}><X className="size-4" /></button>
            </p>
          )}
          {error && (
            <div role="alert" className="space-y-2 rounded-xl border-l-4 border-destructive bg-destructive/10 px-3.5 py-3 text-sm">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" /><span className="flex-1 whitespace-pre-line">{error}</span>
                <button type="button" aria-label="Dismiss" className="-m-1 p-1" onClick={() => setError("")}><X className="size-4" /></button>
              </div>
              {prefs.engine !== "offline" && active.length > 0 && !working && (
                <div className="flex flex-wrap gap-2 pl-6">
                  <Button size="sm" variant="outline" onClick={() => void summarize()}><RotateCcw />Try again</Button>
                  <Button size="sm" variant="outline" onClick={() => { setEngine("offline"); setError(""); }}><Cpu />Switch to on-device</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEngineOpen(true)}>Change key / model</Button>
                </div>
              )}
            </div>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="min-w-0 space-y-8">
              <SourcesPanel
                sources={sources}
                included={included}
                flagged={flagged}
                keywords={topics.keywords}
                busy={busy}
                busyLabel={busyLabel}
                onFiles={(files) => void onFiles(files)}
                onPaste={(text) => addSources([makeSource("Pasted text", "Pasted text", text)])}
                onUrl={onUrl}
                onSample={onSample}
                onRemove={(id) => { setSources((c) => c.filter((s) => s.id !== id)); setOverrides(({ [id]: _drop, ...rest }) => rest); invalidate(); }}
                onToggle={(id, value) => { setOverrides((o) => ({ ...o, [id]: value })); invalidate(); }}
                onFinding={(sid, fid, value) => { setSources((c) => c.map((s) => (s.id === sid ? { ...s, findings: s.findings.map((f) => (f.id === fid ? { ...f, included: value } : f)) } : s))); invalidate(); }}
                onChapter={(sid, cid, value) => patchSource(sid, (src) => ({ ...src, chapters: (src.chapters ?? []).map((c) => (c.id === cid ? { ...c, included: value } : c)) }))}
                onAllChapters={(sid, value) => patchSource(sid, (src) => ({ ...src, chapters: (src.chapters ?? []).map((c) => ({ ...c, included: value })) }))}
                onSplit={onSplit}
                onStop={stop}
              />
              <div ref={resultRef} className="scroll-mt-4">{result && <OutputPanel result={result} rerunning={working} status={snapStatus} onRerun={() => void summarize()} />}</div>
            </div>
            {sources.length > 0 && (
              <div className="lg:sticky lg:top-4">
                <ReviewPanel
                  sources={sources}
                  included={included}
                  topics={topics}
                  onFinding={(sid, fid, value) => { setSources((c) => c.map((s) => (s.id === sid ? { ...s, findings: s.findings.map((f) => (f.id === fid ? { ...f, included: value } : f)) } : s))); invalidate(); }}
                  onAllFindings={(value) => { setSources((c) => c.map((s) => ({ ...s, findings: s.findings.map((f) => ({ ...f, included: value })) }))); invalidate(); }}
                  onToggleSource={(id, value) => { setOverrides((o) => ({ ...o, [id]: value })); invalidate(); }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1 text-sm">
            {summarizing ? (
              <>
                <p className="truncate font-medium">{busyLabel}…</p>
                <Progress value={Math.round(progress * 100)} className="mt-1.5 h-1.5" />
              </>
            ) : result ? (
              <button type="button" onClick={() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} className="text-left">
                <p className="flex items-center gap-1.5 truncate font-semibold text-primary"><Check className="size-4" />Summary ready · tap to view</p>
                <p className="truncate text-xs text-muted-foreground">{result.outputWords.toLocaleString()} words · Copy, Markdown, PowerPoint below it</p>
              </button>
            ) : active.length ? (
              <>
                <p className="truncate font-medium">{active.length} source{active.length === 1 ? "" : "s"} · {inputWords.toLocaleString()} words → ~{targetWords.toLocaleString()} ({Math.round(prefs.ratio * 100)}%)</p>
                <button type="button" onClick={() => setEngineOpen(true)} className={`truncate text-xs underline-offset-2 hover:underline ${engine.ready ? "text-muted-foreground" : "font-semibold text-accent"}`}>{engine.label} · {engine.detail}</button>
              </>
            ) : (
              <p className="text-muted-foreground">Add a source to begin.</p>
            )}
          </div>
          {summarizing ? (
            <Button variant="outline" className="h-12 px-5" onClick={stop}><X />Stop</Button>
          ) : (
            <Button className="h-12 px-6 text-base" disabled={!canSummarize} onClick={() => void summarize()}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              {engine.ready || !active.length ? "Summarize" : "Set up engine"}
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}
