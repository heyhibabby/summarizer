import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpenText,
  Check,
  ChevronDown,
  FileText,
  Image,
  Info,
  LoaderCircle,
  Plus,
  Settings2,
  ShieldAlert,
  Sparkles,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  countWords,
  deduplicateLines,
  findReviewFindings,
  findTopicOutliers,
  friendlyNetworkError,
  listProviderModels,
  providerDetails,
  requestCompletion,
  targetWordCount,
  textWithoutExcludedFindings,
  type Finding,
  type ProviderId,
  type SourceRecord,
} from "@/lib/summarizer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Briefly — private document summarizer" },
      { name: "description", content: "Compare, condense, and combine up to five documents in your browser with the AI provider you choose." },
      { property: "og:title", content: "Briefly — private document summarizer" },
      { property: "og:description", content: "A browser-first workspace for comparing and combining documents with your own AI provider key." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Home,
});

const MAX_SOURCES = 5;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 400_000;
const ACCEPTED_FILES = ".pdf,.txt,.md,.markdown,text/plain,text/markdown,application/pdf";
const STORAGE_KEY = "briefly-provider-keys-v1";
const SETTINGS_KEY = "briefly-provider-settings-v1";

type ProviderSettings = { provider: ProviderId; models: Partial<Record<ProviderId, string>> };
type SavedKeys = Partial<Record<ProviderId, string>>;
type Phase = "intake" | "review" | "summary";

function makeSource(name: string, kind: SourceRecord["kind"], text: string, note?: string): SourceRecord {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    kind,
    text,
    ...(note ? { note } : {}),
    status: "ready",
    findings: findReviewFindings(text),
  };
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function Home() {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>({ provider: "google", models: {} });
  const [savedKeys, setSavedKeys] = useState<SavedKeys>({});
  const [keyDraft, setKeyDraft] = useState("");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [topicOutliers, setTopicOutliers] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("intake");
  const [pastedText, setPastedText] = useState("");
  const [articleUrl, setArticleUrl] = useState("");
  const [summary, setSummary] = useState("");
  const [inputWords, setInputWords] = useState(0);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pptxConfirmation, setPptxConfirmation] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [providerCheck, setProviderCheck] = useState("");
  const [articleStage, setArticleStage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeOperationRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setSavedKeys(readLocal<SavedKeys>(STORAGE_KEY, {}));
    setProviderSettings(readLocal<ProviderSettings>(SETTINGS_KEY, { provider: "google", models: {} }));
    setStorageReady(true);
  }, []);

  const activeProvider = providerSettings.provider;
  const activeKey = savedKeys[activeProvider] ?? "";
  const activeModel = providerSettings.models[activeProvider] ?? "";
  const selectedSources = useMemo(() => sources.filter((source) => source.status === "ready"), [sources]);
  const allFindings = useMemo(() => selectedSources.flatMap((source) => source.findings.map((finding) => ({ ...finding, sourceId: source.id, sourceName: source.name }))), [selectedSources]);
  const includedSourceWords = useMemo(() => selectedSources.filter((source) => !topicOutliers.includes(source.id)).reduce((sum, source) => sum + countWords(source.text), 0), [selectedSources, topicOutliers]);
  const plannedTarget = targetWordCount(includedSourceWords);

  useEffect(() => {
    if (!storageReady) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedKeys));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(providerSettings));
    } catch {
      setErrorMessage("This browser could not save your provider settings. You can still use a key for this visit without saving it.");
    }
  }, [savedKeys, providerSettings, storageReady]);

  useEffect(() => {
    if (!activeKey) {
      setModels([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void listProviderModels(activeProvider, activeKey, controller.signal)
        .then((nextModels) => setModels(nextModels))
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) setModels([]);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeKey, activeProvider]);

  const addSources = useCallback((next: SourceRecord[]) => {
    setSources((current) => {
      const available = Math.max(0, MAX_SOURCES - current.length);
      const accepted = next.slice(0, available);
      if (accepted.length < next.length) setNotice("Five sources is the batch limit. Extra items were not added.");
      const updated = [...current, ...accepted];
      if (updated.length > 1) setTopicOutliers(findTopicOutliers(updated));
      setSummary("");
      setPhase(updated.length > 1 ? "review" : "intake");
      return updated;
    });
    setErrorMessage("");
  }, []);

  const parseFiles = useCallback(async (fileList: FileList | File[]) => {
    const incoming = Array.from(fileList);
    if (!incoming.length) return;
    const space = MAX_SOURCES - sources.length;
    if (space <= 0) {
      setNotice("This batch already has five sources. Remove one before adding another.");
      return;
    }
    const files = incoming.slice(0, space);
    if (files.length < incoming.length) setNotice("This batch can hold five sources. Only the available slots were started.");
    const controller = new AbortController();
    activeOperationRef.current?.abort();
    activeOperationRef.current = controller;
    setBusy(true);
    setBusyLabel("Reading files");
    setErrorMessage("");
    const extracted: SourceRecord[] = [];
    const failures: string[] = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file) continue;
        if (controller.signal.aborted) throw new DOMException("Stopped", "AbortError");
        setBusyLabel(`Reading ${index + 1} of ${files.length} · ${file.name}`);
        if (file.size > MAX_FILE_BYTES) {
          failures.push(`${file.name}: larger than the 24 MB per-file working limit.`);
          continue;
        }
        const ext = file.name.toLowerCase().split(".").pop();
        if (ext === "pdf" || file.type === "application/pdf") {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
          const bytes = new Uint8Array(await file.arrayBuffer());
          const document = await pdfjs.getDocument({ data: bytes }).promise;
          const pageLimit = Math.min(document.numPages, 40);
          const pageParts: string[] = [];
          for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
            if (controller.signal.aborted) throw new DOMException("Stopped", "AbortError");
            setBusyLabel(`Reading ${file.name} · page ${pageNumber} of ${pageLimit}`);
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            const lines = content.items.flatMap((item) => "str" in item && item.str ? [item.str] : []);
            pageParts.push(lines.join(" "));
          }
          const text = pageParts.join("\n\n").slice(0, MAX_EXTRACTED_CHARS);
          if (countWords(text) < 20) {
            failures.push(`${file.name}: little or no selectable text. This may be a scanned or image-only PDF; use OCR or paste its text.`);
          } else {
            const note = document.numPages > pageLimit ? `Read the first ${pageLimit} pages of ${document.numPages}.` : "PDF visuals, tables, and scanned text may not be captured by text extraction.";
            extracted.push(makeSource(file.name, "PDF", text, note));
          }
          await document.cleanup();
        } else if (["txt", "md", "markdown"].includes(ext ?? "") || file.type.startsWith("text/")) {
          const text = (await file.text()).slice(0, MAX_EXTRACTED_CHARS);
          if (!text.trim()) failures.push(`${file.name}: no readable text found.`);
          else extracted.push(makeSource(file.name, ext === "md" || ext === "markdown" ? "Markdown" : "Text", text, file.size > MAX_EXTRACTED_CHARS ? "Read the first 400,000 characters." : undefined));
        } else {
          failures.push(`${file.name}: use PDF, plain text, or Markdown.`);
        }
      }
      if (extracted.length) addSources(extracted);
      if (failures.length) setErrorMessage(failures.join(" "));
    } catch (error) {
      setErrorMessage(friendlyNetworkError(error));
    } finally {
      setBusy(false);
      setBusyLabel("");
      activeOperationRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [addSources, sources.length]);

  const addArticle = useCallback(async () => {
    const value = articleUrl.trim();
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an http or https article address.");
      setBusy(true);
      setBusyLabel("Trying to read the article");
      setErrorMessage("");
      const controller = new AbortController();
      activeOperationRef.current?.abort();
      activeOperationRef.current = controller;
      const response = await fetch(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`The article returned ${response.status}. Copy the article text or add a downloaded text file instead.`);
      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, "text/html");
      parsed.querySelectorAll("script,style,nav,footer,header,aside,form").forEach((node) => node.remove());
      const text = (parsed.querySelector("article,main")?.textContent ?? parsed.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_EXTRACTED_CHARS);
      if (countWords(text) < 80) throw new Error("Too little readable article text was found. Copy the article into the paste box or use a downloaded file.");
      addSources([makeSource(parsed.title || url.hostname, "Article", text, "Article images, tables, and charts are not extracted by this browser reader.")]);
      setArticleUrl("");
      setArticleStage(false);
    } catch (error) {
      setErrorMessage(error instanceof TypeError
        ? "This article site blocks reading from the browser, or the network is unavailable. Copy its text into the paste box or add a downloaded text/PDF file instead."
        : friendlyNetworkError(error));
      setArticleStage(true);
    } finally {
      setBusy(false);
      setBusyLabel("");
      activeOperationRef.current = null;
    }
  }, [articleUrl, addSources]);

  const addPastedSource = () => {
    if (!pastedText.trim()) return;
    addSources([makeSource("Pasted text", "Pasted text", pastedText.slice(0, MAX_EXTRACTED_CHARS), pastedText.length > MAX_EXTRACTED_CHARS ? "Kept the first 400,000 characters." : undefined)]);
    setPastedText("");
    setShowPaste(false);
  };

  const setSourceIncluded = (sourceId: string, checked: boolean) => {
    setTopicOutliers((current) => checked ? current.filter((id) => id !== sourceId) : [...new Set([...current, sourceId])]);
  };

  const setFindingIncluded = (sourceId: string, findingId: string, included: boolean) => {
    setSources((current) => current.map((source) => source.id === sourceId ? { ...source, findings: source.findings.map((finding) => finding.id === findingId ? { ...finding, included } : finding) } : source));
  };

  const updateProvider = (provider: ProviderId) => {
    setProviderSettings((current) => ({ ...current, provider }));
    setProviderCheck("");
  };

  const saveProviderKey = () => {
    const value = keyDraft.trim();
    if (!value) {
      setErrorMessage("Enter a key to save on this device.");
      return;
    }
    setSavedKeys((current) => ({ ...current, [activeProvider]: value }));
    setKeyDraft("");
    setProviderCheck("Key saved in this browser on this device.");
    setErrorMessage("");
  };

  const checkProvider = async () => {
    if (!activeKey) {
      setProviderCheck("Add a key first.");
      return;
    }
    setBusy(true);
    setBusyLabel("Checking provider models");
    try {
      const nextModels = await listProviderModels(activeProvider, activeKey);
      setModels(nextModels);
      setProviderCheck(`${nextModels.length} text models found. Key can list models.`);
      const savedModel = providerSettings.models[activeProvider];
      if (!savedModel || !nextModels.some((model) => model.id === savedModel)) {
        const defaultModel = defaultModelFor(activeProvider, nextModels);
        if (defaultModel) setProviderSettings((current) => ({ ...current, models: { ...current.models, [activeProvider]: defaultModel } }));
      }
    } catch (error) {
      setProviderCheck(friendlyNetworkError(error));
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  };

  const startReview = () => {
    const ready = selectedSources.filter((source) => !topicOutliers.includes(source.id));
    if (!ready.length) {
      setErrorMessage("Include at least one source before reviewing the summary.");
      return;
    }
    setPhase("review");
    setErrorMessage("");
    setNotice("");
  };

  const runSummary = async () => {
    const activeSources = selectedSources.filter((source) => !topicOutliers.includes(source.id));
    const missingKey = !activeKey;
    const selectedModel = models.find((model) => model.id === activeModel)?.id ?? activeModel;
    if (missingKey || !selectedModel) {
      setErrorMessage("Choose a provider, add its key, check its model list, and select a model before summarizing.");
      setShowSettings(true);
      return;
    }
    if (!activeSources.length) {
      setErrorMessage("Include at least one source first.");
      return;
    }
    const reviewable = allFindings.filter((finding) => !topicOutliers.includes(finding.sourceId));
    const includedFindings = reviewable.filter((finding) => finding.included);
    const excludedFindings = reviewable.filter((finding) => !finding.included);
    const content = activeSources.map((source) => `SOURCE: ${source.name}\n${textWithoutExcludedFindings(source)}`).join("\n\n");
    const originalCount = activeSources.reduce((sum, source) => sum + countWords(textWithoutExcludedFindings(source)), 0);
    const targetCount = targetWordCount(originalCount);
    const findingsContext = includedFindings.length
      ? `\nReviewable visual references explicitly retained by the user:\n${includedFindings.map((finding) => `- [${finding.kind}] ${finding.sourceName}: ${finding.excerpt}`).join("\n")}`
      : "\nNo image, table, or chart findings were selected for inclusion.";
    const excludedContext = excludedFindings.length
      ? `\nDo not use these explicitly excluded findings:\n${excludedFindings.map((finding) => `- [${finding.kind}] ${finding.sourceName}: ${finding.excerpt}`).join("\n")}`
      : "";
    const prompt = `Create one concise, accurate, topic-aligned merged summary of all supplied sources. The target is approximately ${targetCount} words (about 5% of the combined ${originalCount} input words). Treat this only as an approximate target; never invent facts to hit it. Merge overlapping ideas, remove exact and near-duplicate claims, preserve essential qualifications, and include source names in compact inline citations. Keep distinct themes only if they are meaningfully present. Use a short descriptive title, then a clear summary and key points. Do not add generic advice or unsupported claims.${findingsContext}${excludedContext}\n\nSource material:\n${content}`;
    const controller = new AbortController();
    activeOperationRef.current?.abort();
    activeOperationRef.current = controller;
    setPhase("summary");
    setBusy(true);
    setBusyLabel(`Summarizing with ${providerDetails[activeProvider].label}`);
    setSummary("");
    setInputWords(originalCount);
    setErrorMessage("");
    setNotice("");
    try {
      const result = await requestCompletion(activeProvider, activeKey, selectedModel, prompt, controller.signal);
      setSummary(deduplicateLines(result));
      setPhase("summary");
    } catch (error) {
      setPhase("review");
      setErrorMessage(friendlyNetworkError(error));
    } finally {
      setBusy(false);
      setBusyLabel("");
      activeOperationRef.current = null;
    }
  };

  const cancelActive = () => activeOperationRef.current?.abort();

  const clearSession = () => {
    activeOperationRef.current?.abort();
    setSources([]);
    setTopicOutliers([]);
    setSummary("");
    setInputWords(0);
    setPastedText("");
    setArticleUrl("");
    setPhase("intake");
    setErrorMessage("");
    setNotice("The current source and summary session was cleared from this page.");
  };

  const clearKeys = () => {
    setSavedKeys({});
    setKeyDraft("");
    setProviderSettings((current) => ({ ...current, models: {} }));
    setModels([]);
    setProviderCheck("Saved provider keys and model choices were cleared from this browser.");
  };

  const downloadSummary = () => {
    if (!summary) return;
    const blob = new Blob([`${summary}\n\nSources\n${selectedSources.filter((source) => !topicOutliers.includes(source.id)).map((source) => `- ${source.name}`).join("\n")}\n\nApproximate target: ${targetWordCount(inputWords)} words; generated: ${countWords(summary)} words.\n`], { type: "text/markdown;charset=utf-8" });
    downloadBlob(blob, "briefly-merged-summary.md");
  };

  const downloadPowerPoint = async () => {
    if (!summary) return;
    setPptxConfirmation(false);
    setBusy(true);
    setBusyLabel("Building your presentation");
    try {
      const imported = await import("pptxgenjs");
      const PptxGenJS = imported.default;
      const presentation = new PptxGenJS();
      presentation.layout = "LAYOUT_WIDE";
      presentation.author = "Briefly";
      presentation.subject = "Merged document summary";
      presentation.title = "Merged summary";
      presentation.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos" };
      const paragraphs = summary.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const title = paragraphs[0]?.replace(/^#+\s*/, "") || "Merged summary";
      const cover = presentation.addSlide();
      cover.background = { color: "F6F5EF" };
      cover.addText(title, { x: 0.8, y: 0.75, w: 11, h: 1.25, fontFace: "Aptos Display", fontSize: 30, bold: true, color: "183A36", breakLine: false, margin: 0.02 });
      cover.addShape(presentation.ShapeType.rect, { x: 0.82, y: 2.24, w: 2.1, h: 0.08, fill: { color: "D4684B" }, line: { color: "D4684B" } });
      cover.addText(`Merged from ${selectedSources.filter((source) => !topicOutliers.includes(source.id)).length} source items · ${inputWords.toLocaleString()} input words`, { x: 0.82, y: 2.55, w: 10.8, h: 0.55, fontFace: "Aptos", fontSize: 15, color: "52615B", margin: 0.02 });
      const contentText = paragraphs.slice(1).join(" ") || title;
      const sentences = contentText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [contentText];
      const chunks: string[][] = [];
      let chunk: string[] = [];
      let words = 0;
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        const weight = countWords(trimmed);
        if (chunk.length && words + weight > 58) {
          chunks.push(chunk);
          chunk = [];
          words = 0;
        }
        chunk.push(trimmed);
        words += weight;
      }
      if (chunk.length) chunks.push(chunk);
      for (let index = 0; index < chunks.length; index += 1) {
        const slide = presentation.addSlide();
        slide.background = { color: "F6F5EF" };
        slide.addText(`KEY IDEA  ${String(index + 1).padStart(2, "0")}`, { x: 0.75, y: 0.55, w: 8.5, h: 0.35, fontFace: "Aptos", fontSize: 12, bold: true, color: "53766D", charSpacing: 1.4, margin: 0.02 });
        slide.addText(title, { x: 0.75, y: 0.98, w: 11.4, h: 0.66, fontFace: "Aptos Display", fontSize: 24, bold: true, color: "183A36", margin: 0.02, breakLine: false });
        slide.addShape(presentation.ShapeType.line, { x: 0.78, y: 1.82, w: 0.95, h: 0, line: { color: "D4684B", width: 2.8 } });
        const items = chunks[index] ?? [];
        slide.addText(items.map((text) => ({ text, options: { bullet: { indent: 18 }, hanging: 4, breakLine: true, paraSpaceAfterPt: 18 } })), {
          x: 0.88,
          y: 2.1,
          w: 11,
          h: 4.45,
          fontFace: "Aptos",
          fontSize: items.length > 3 ? 17 : 19,
          color: "2B3632",
          breakLine: false,
          margin: 0.06,
          valign: "middle",
          fit: "shrink",
        });
        slide.addShape(presentation.ShapeType.rect, { x: 0, y: 7.28, w: 13.333, h: 0.22, fill: { color: "183A36" }, line: { color: "183A36" } });
        slide.addText(selectedSources.filter((source) => !topicOutliers.includes(source.id)).map((source) => source.name).join(" · ").slice(0, 150), { x: 0.8, y: 6.75, w: 10.2, h: 0.24, fontFace: "Aptos", fontSize: 9, color: "697570", margin: 0.02 });
        slide.addText(`${index + 2}`, { x: 11.65, y: 6.72, w: 0.7, h: 0.3, fontFace: "Aptos", fontSize: 10, color: "697570", align: "right", margin: 0.02 });
      }
      await presentation.writeFile({ fileName: "briefly-merged-summary.pptx" });
    } catch (error) {
      setErrorMessage(friendlyNetworkError(error));
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  };

  const selectedModelExists = models.some((model) => model.id === activeModel);
  const measuredOutputWords = countWords(summary);
  const progressPercent = inputWords ? Math.min(100, Math.round((measuredOutputWords / Math.max(plannedTarget, 1)) * 100)) : 0;

  return (
    <TooltipProvider>
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto min-h-screen max-w-6xl px-4 pb-28 sm:px-6 lg:px-8">
        <header className="flex h-[4.25rem] items-center justify-between border-b border-border">
          <a className="flex items-center gap-2.5" href="/" aria-label="Briefly home">
            <span className="grid size-8 place-items-center rounded-sm bg-primary text-primary-foreground"><BookOpenText className="size-[18px]" /></span>
            <span className="font-serif text-[21px] font-semibold">briefly<span className="text-accent">.</span></span>
          </a>
          <div className="flex items-center gap-2">
            {sources.length > 0 && <span className="mr-1 hidden text-xs text-muted-foreground sm:inline">{sources.length} / {MAX_SOURCES} sources</span>}
            <InfoTip label="Privacy details" text="Your files, source text, and summary stay in this browser. Only included source text is sent directly to the provider you choose when you summarize. Saved keys are stored in this browser profile and may be accessible to someone with access to it; this is not a secure vault. Check your provider’s privacy, retention, pricing, and quota terms. Direct browser calls can be blocked by network or CORS limits. Native Android and iOS packaging and secure key storage are not yet tested." />
            <Button variant="ghost" size="icon" aria-label="Provider settings" title="Provider settings" onClick={() => setShowSettings((value) => !value)}>
              {showSettings ? <X /> : <Settings2 />}
            </Button>
          </div>
        </header>

        {showSettings && <section className="mb-7 border-y border-border bg-secondary/40 py-5" aria-label="AI provider settings">
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-12">
            <div className="space-y-4">
              <div className="flex items-center gap-1"><h2 className="font-serif text-2xl">Provider</h2><InfoTip label="Provider information" text={`${providerDetails[activeProvider].keyHelp} ${providerDetails[activeProvider].limitation}`} /></div>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Choose AI provider">
                {(["google", "openai", "openrouter"] as ProviderId[]).map((provider) => <Button key={provider} variant={activeProvider === provider ? "default" : "outline"} size="sm" className="min-w-0 px-2 text-xs" onClick={() => updateProvider(provider)}>{provider === "google" ? "Gemini" : provider === "openai" ? "OpenAI" : "OpenRouter"}</Button>)}
              </div>
              <div className="flex gap-2">
                <Input type="password" autoComplete="off" spellCheck={false} aria-label={`${providerDetails[activeProvider].label} API key`} placeholder="API key" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} />
                <Button size="sm" onClick={saveProviderKey}>Save</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={!activeKey || busy} onClick={() => void checkProvider()}>{busy && busyLabel === "Checking provider models" ? <LoaderCircle className="animate-spin" /> : null}Check models</Button>
                <Button variant="ghost" size="sm" disabled={!activeKey} onClick={() => { setSavedKeys((current) => { const next = { ...current }; delete next[activeProvider]; return next; }); setModels([]); setProviderCheck("This provider key was cleared from this browser."); }}>Clear this key</Button>
                <Button variant="ghost" size="sm" onClick={clearKeys}>Clear all keys</Button>
              </div>
              {providerCheck && <p className="text-xs leading-5 text-muted-foreground" role="status">{providerCheck}</p>}
              <div className="space-y-1.5">
                <label className="text-xs font-medium" htmlFor="model-choice">Model</label>
                {models.length ? <div className="relative"><select id="model-choice" className="h-10 w-full appearance-none rounded-sm border border-input bg-background px-3 pr-9 text-sm" value={activeModel} onChange={(event) => setProviderSettings((current) => ({ ...current, models: { ...current.models, [activeProvider]: event.target.value } }))}><option value="">Choose a model</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-3 size-4 text-muted-foreground" /></div> : <p className="border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">{activeKey ? "Loading models…" : "Add API key to load models"}</p>}
                {activeModel && !selectedModelExists && <p className="text-xs text-accent">Model unavailable. Refresh the model list.</p>}
              </div>
            </div>
            <div className="flex items-start gap-2 border-t border-border pt-5 md:border-l md:border-t-0 md:pl-8 md:pt-0"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-accent" /><InfoTip label="Provider and key details" text="The key is saved only in this browser profile, not in a device-secure vault. Included source text is sent directly to the selected provider. Provider pricing, quotas, model availability, and browser access vary. If a direct browser request is blocked, no other provider is selected automatically." /></div>
          </div>
        </section>}

        <div className="mb-4 flex items-center justify-between border-b border-border pb-2.5">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em]">
            <span className={phase === "intake" ? "text-accent" : "text-muted-foreground"}>01 <span className="ml-1">Sources</span></span>
            <span className="text-border">/</span>
            <span className={phase === "review" ? "text-accent" : "text-muted-foreground"}>02 <span className="ml-1">Review</span></span>
            <span className="text-border">/</span>
            <span className={phase === "summary" ? "text-accent" : "text-muted-foreground"}>03 <span className="ml-1">Output</span></span>
          </div>
          {sources.length > 0 && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={clearSession}><Trash2 className="size-3.5" />Clear session</Button>}
        </div>

        {notice && <div className="mb-4 flex items-start gap-2 border-l-2 border-accent bg-secondary/50 px-3 py-2.5 text-xs leading-5" role="status"><Check className="mt-0.5 size-4 shrink-0 text-accent" />{notice}<Button variant="ghost" size="icon" className="ml-auto -mt-1 size-7 shrink-0" aria-label="Dismiss notice" onClick={() => setNotice("")}><X className="size-3.5" /></Button></div>}
        {errorMessage && <div className="mb-4 flex items-start gap-2 border-l-2 border-destructive bg-destructive/5 px-3 py-2.5 text-xs leading-5 text-foreground" role="alert"><AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" /><span>{errorMessage}</span><Button variant="ghost" size="icon" className="ml-auto -mt-1 size-7 shrink-0" aria-label="Dismiss error" onClick={() => setErrorMessage("")}><X className="size-3.5" /></Button></div>}

        <div className="grid gap-7 md:grid-cols-[minmax(0,1fr)_18rem] md:gap-12">
          <section aria-label="Document sources">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div className="flex items-center gap-1"><h2 className="font-serif text-2xl sm:text-[28px]">Sources</h2><InfoTip label="Source input details" text="Add up to five PDFs, plain text or Markdown files, pasted text, or public article URLs. Files are read on this device. Files may be up to 24 MB; PDF text extraction reads up to 40 pages or 400,000 characters. Scans and embedded visual content may not be captured." /></div>
              <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">{sources.length.toString().padStart(2, "0")} / 05</span>
            </div>

            <div className="divide-y divide-border border-y border-border">
              {sources.length === 0 && !busy && <div className="py-7">
                <p className="text-sm text-muted-foreground">No sources</p>
              </div>}
              {sources.map((source, index) => <SourceRow key={source.id} source={source} index={index} outlier={topicOutliers.includes(source.id)} onRemove={() => { setSources((current) => { const next = current.filter((item) => item.id !== source.id); setTopicOutliers(findTopicOutliers(next)); return next; }); setSummary(""); }} onToggle={(included) => setSourceIncluded(source.id, included)} onFindingToggle={(findingId, included) => setFindingIncluded(source.id, findingId, included)} />)}
              {busy && <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin text-accent" />{busyLabel}<Button variant="ghost" size="sm" className="ml-auto" onClick={cancelActive}>Stop</Button></div>}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <input ref={fileInputRef} type="file" accept={ACCEPTED_FILES} multiple className="sr-only" aria-label="Choose PDF, plain text, or Markdown files" onChange={(event) => { if (event.target.files) void parseFiles(event.target.files); }} />
              <Button onClick={() => fileInputRef.current?.click()} disabled={busy || sources.length >= MAX_SOURCES} className="flex-1 sm:flex-none"><Plus />Add files</Button>
              <Button variant="outline" onClick={() => { setShowPaste((value) => !value); setArticleStage(false); }} disabled={sources.length >= MAX_SOURCES}><FileText />Paste text</Button>
              <Button variant="outline" onClick={() => { setArticleStage((value) => !value); setShowPaste(false); }} disabled={sources.length >= MAX_SOURCES}><ArrowDownToLine />Article URL</Button>
            </div>
            {showPaste && <div className="mt-4 border-t border-border pt-4">
              <div className="mb-2 flex items-center justify-between"><label htmlFor="paste-source" className="text-xs font-medium">Source text</label><Button variant="ghost" size="sm" onClick={() => setShowPaste(false)}>Close</Button></div>
              <Textarea id="paste-source" value={pastedText} onChange={(event) => setPastedText(event.target.value)} placeholder="Paste text" className="min-h-36 resize-y text-sm" />
              <Button className="mt-2" size="sm" disabled={!pastedText.trim() || sources.length >= MAX_SOURCES} onClick={addPastedSource}>Add source</Button>
            </div>}

            {articleStage && <div className="mt-4 border-t border-border pt-4">
              <div className="mb-2 flex items-center gap-1"><label htmlFor="article-address" className="text-xs font-medium">Article URL</label><InfoTip label="Article URL details" text="Many sites block reading from browsers. If reading fails, paste the article text or add a downloaded text or PDF file. Site restrictions are not bypassed." /></div>
              <div className="flex flex-col gap-2 sm:flex-row"><Input id="article-address" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" value={articleUrl} onChange={(event) => setArticleUrl(event.target.value)} placeholder="https://" /><Button onClick={() => void addArticle()} disabled={!articleUrl.trim() || busy || sources.length >= MAX_SOURCES}>Add URL</Button></div>
            </div>}

            {sources.length > 1 && <div className="mt-7 border-t border-border pt-5">
              <div className="mb-3 flex items-center gap-2"><div className="grid size-8 shrink-0 place-items-center rounded-sm bg-secondary text-accent"><Sparkles className="size-4" /></div><h3 className="text-sm font-semibold">Topic check</h3><InfoTip label="Topic check details" text="A simple comparison of shared words identifies sources that may not match the others. Review the warning and include or exclude each flagged source." /></div>
              {topicOutliers.length ? <div className="border-l-2 border-accent bg-accent/5 p-3 text-xs leading-5"><div className="flex items-center gap-1"><p className="font-semibold">Topic warning</p><InfoTip label="Topic warning details" text="These sources differ from the majority based on shared words. Include them intentionally or leave them excluded." /></div><p className="mt-1 text-muted-foreground">{sources.filter((source) => topicOutliers.includes(source.id)).map((source) => source.name).join(", ")}</p><div className="mt-2 flex flex-wrap gap-2">{sources.filter((source) => topicOutliers.includes(source.id)).map((source) => <label key={source.id} className="flex items-center gap-2"><Checkbox checked={false} onCheckedChange={(checked) => setSourceIncluded(source.id, checked === true)} />Include {source.name}</label>)}</div></div> : <p className="flex items-center gap-2 text-xs text-muted-foreground"><Check className="size-4 text-accent" />Topics aligned</p>}
            </div>}
          </section>

          <aside className="border-t border-border pt-5 md:border-l md:border-t-0 md:pl-7 md:pt-0" aria-label="Review and summary controls">
            <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-1"><h2 className="font-serif text-xl">Review</h2><InfoTip label="Review details" text="Findings are based on text mentions only. Embedded PDF pictures, tables, charts, and scanned text may not be visible to this reader." /></div><span className="text-xs tabular-nums text-muted-foreground">{allFindings.length} found</span></div>
              {allFindings.length > 0 && <div className="flex gap-2 border-y border-border py-2"><Button variant="link" size="sm" className="h-7 px-1 text-xs" onClick={() => setSources((current) => current.map((source) => ({ ...source, findings: source.findings.map((finding) => ({ ...finding, included: true })) })))}>Include all</Button><Button variant="link" size="sm" className="h-7 px-1 text-xs text-muted-foreground" onClick={() => setSources((current) => current.map((source) => ({ ...source, findings: source.findings.map((finding) => ({ ...finding, included: false })) })))}>Exclude all</Button></div>}
            <div className="max-h-72 divide-y divide-border overflow-auto">
              {allFindings.map((finding) => <FindingRow key={`${finding.sourceId}-${finding.id}`} finding={finding} sourceName={finding.sourceName} onToggle={(included) => setFindingIncluded(finding.sourceId, finding.id, included)} />)}
              {!allFindings.length && <div className="flex items-center gap-1 py-4 text-xs text-muted-foreground"><span>No findings</span><InfoTip label="Review limitations" text="Findings are identified from text mentions only. Selectable PDF text is not a full visual analysis; embedded images, tables, charts, or scanned text may be missed." /></div>}
            </div>

            <div className="mt-6 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-1"><h2 className="font-serif text-xl">Output</h2><InfoTip label="Output target details" text="The target is approximately 5% of the combined original input word count, including uploaded summaries. It is an estimate, not a strict limit." /></div><span className="rounded-sm bg-secondary px-2 py-1 font-mono text-[10px] text-muted-foreground">~5%</span></div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-y border-border py-3">
                <div><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Input</p><p className="mt-1 font-mono text-xl tabular-nums">{(phase === "summary" ? inputWords : includedSourceWords).toLocaleString()}</p><p className="text-[10px] text-muted-foreground">words</p></div>
                <div><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Target</p><p className="mt-1 font-mono text-xl tabular-nums">{targetWordCount(phase === "summary" ? inputWords : includedSourceWords).toLocaleString()}</p><p className="text-[10px] text-muted-foreground">words</p></div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2 text-xs"><span className="text-muted-foreground">AI provider</span><Button variant="link" size="sm" className="h-7 gap-1 px-1" onClick={() => setShowSettings(true)}>{providerDetails[activeProvider].label}<ChevronDown className="size-3.5" /></Button></div>
              {phase === "intake" && sources.length > 0 && <Button variant="outline" className="mt-4 w-full" onClick={startReview}>Review included sources</Button>}
              {phase === "review" && <Button className="mt-4 w-full" disabled={busy || !selectedSources.some((source) => !topicOutliers.includes(source.id))} onClick={() => void runSummary()}><Sparkles />Summarize</Button>}
              {phase === "summary" && summary && <div className="mt-4 space-y-2"><Button className="w-full" variant="outline" onClick={downloadSummary}><ArrowDownToLine />Download summary</Button><Button className="w-full" onClick={() => setPptxConfirmation(true)} disabled={busy}><FileText />Make PowerPoint</Button></div>}
            </div>
          </aside>
        </div>

        {phase === "summary" && summary && <section className="mt-8 border-t border-border pt-6" aria-label="Merged summary">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><h2 className="font-serif text-3xl">Output</h2><div className="flex items-center gap-3 text-xs text-muted-foreground"><span>{inputWords.toLocaleString()} in</span><span className="h-3 w-px bg-border" /><span>{measuredOutputWords.toLocaleString()} out</span><span className="h-3 w-px bg-border" /><span>~{targetWordCount(inputWords).toLocaleString()} target</span></div></div>
          {Math.abs(measuredOutputWords - targetWordCount(inputWords)) > Math.max(5, targetWordCount(inputWords) * 0.5) && <div className="mb-4 flex items-start gap-2 border-l-2 border-accent bg-secondary/40 p-3 text-xs leading-5"><AlertCircle className="mt-0.5 size-4 shrink-0 text-accent" /><span>Warning: output length differs from the ~5% target.</span><InfoTip label="Output length warning details" text="A readable summary takes priority over exact length. Review the output before downloading." /></div>}
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words border-y border-border bg-secondary/25 px-4 py-4 font-sans text-sm leading-7">{summary}</pre>
          <div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" onClick={downloadSummary}><ArrowDownToLine />Download Markdown</Button><Button onClick={() => setPptxConfirmation(true)}><FileText />Make PowerPoint</Button></div>
        </section>}

      </div>

      {pptxConfirmation && <div className="fixed inset-0 z-50 grid place-items-end bg-foreground/40 p-0 sm:place-items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setPptxConfirmation(false); }}>
        <section role="dialog" aria-modal="true" aria-labelledby="pptx-title" className="w-full max-w-md border border-border bg-background p-5 shadow-lg sm:rounded-sm sm:p-6">
          <div className="flex items-start gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-sm bg-secondary text-accent"><FileText className="size-5" /></div><div className="flex items-center gap-1"><h2 id="pptx-title" className="font-serif text-2xl">Create PowerPoint?</h2><InfoTip label="PowerPoint download details" text={`The presentation will include ${summary.split(/\n+/).filter((line) => line.trim()).length + 1} slides with the current output and source names.`} /></div></div>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="outline" onClick={() => setPptxConfirmation(false)}>Not now</Button><Button onClick={() => void downloadPowerPoint()}><Check />Create and download</Button></div>
        </section>
      </div>}
    </main>
    </TooltipProvider>
  );
}

function SourceRow({ source, index, outlier, onRemove, onToggle, onFindingToggle }: {
  source: SourceRecord;
  index: number;
  outlier: boolean;
  onRemove: () => void;
  onToggle: (included: boolean) => void;
  onFindingToggle: (findingId: string, included: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <div className="py-3.5">
    <div className="flex items-start gap-3">
      <span className="mt-0.5 w-5 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
      <div className="grid size-8 shrink-0 place-items-center rounded-sm bg-secondary text-accent">{source.kind === "PDF" ? <FileText className="size-4" /> : source.kind === "Article" ? <BookOpenText className="size-4" /> : <FileText className="size-4" />}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><p className="max-w-full truncate text-sm font-medium" title={source.name}>{source.name}</p><span className="rounded-sm border border-border px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">{source.kind}</span>{outlier && <span className="rounded-sm bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold text-accent">Check topic</span>}</div>
        <p className="mt-1 text-[11px] text-muted-foreground">{countWords(source.text).toLocaleString()} words · {source.findings.length} text-based findings</p>
        {source.note && <p className="mt-1 text-[11px] leading-4 text-accent">{source.note}</p>}
        {source.findings.length > 0 && <button className="mt-1 text-[11px] text-muted-foreground underline underline-offset-2" onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide findings" : "Review findings"}</button>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><Checkbox checked={!outlier} onCheckedChange={(checked) => onToggle(checked === true)} />Include</label>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`Remove ${source.name}`} onClick={onRemove}><X className="size-4" /></Button>
      </div>
    </div>
    {expanded && <div className="ml-8 mt-3 space-y-2 border-l border-border pl-3">{source.findings.map((finding) => <label key={finding.id} className="flex items-start gap-2 text-xs leading-5"><Checkbox checked={finding.included} onCheckedChange={(checked) => onFindingToggle(finding.id, checked === true)} /><span><span className="font-medium capitalize">{finding.kind}</span> · {finding.excerpt}</span></label>)}</div>}
  </div>;
}

function FindingRow({ finding, sourceName, onToggle }: { finding: Finding; sourceName: string; onToggle: (included: boolean) => void }) {
  const Icon = finding.kind === "image" ? Image : finding.kind === "chart" ? Sparkles : Table2;
  return <label className="flex cursor-pointer items-start gap-2.5 py-3 text-xs leading-5">
    <Checkbox checked={finding.included} onCheckedChange={(checked) => onToggle(checked === true)} className="mt-0.5" />
    <Icon className="mt-0.5 size-3.5 shrink-0 text-accent" />
    <span className="min-w-0"><span className="font-medium capitalize">{finding.kind}</span><span className="block truncate text-[10px] text-muted-foreground">{sourceName}</span><span className="mt-0.5 block text-muted-foreground">{finding.excerpt}</span></span>
  </label>;
}

function InfoTip({ label, text }: { label: string; text: string }) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={label}>
        <Info className="size-3.5" />
      </Button>
    </TooltipTrigger>
    <TooltipContent className="max-w-xs leading-5">{text}</TooltipContent>
  </Tooltip>;
}

function defaultModelFor(provider: ProviderId, available: { id: string }[]): string {
  const preferred = provider === "google" ? ["gemini-2.5-flash", "gemini-2.0-flash"] : provider === "openai" ? ["gpt-4.1-mini", "gpt-4o-mini"] : [];
  return available.find((model) => preferred.includes(model.id))?.id ?? available.find((model) => provider === "openrouter" && model.id.includes("/") && /mini|flash/i.test(model.id))?.id ?? "";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}