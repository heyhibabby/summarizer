import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Cpu, ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/app/info-tip";
import { detectProvider, maskKey, PROVIDER_IDS, PROVIDERS, sanitizeKey, type ProviderId } from "@/lib/providers";
import type { Connection, ConnectResult } from "@/lib/connections";
import type { EngineChoice, Keys, Prefs } from "@/lib/settings";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: Prefs;
  keys: Keys;
  storageOk: boolean;
  connections: Partial<Record<ProviderId, Connection>>;
  onEngine: (engine: EngineChoice) => void;
  onConnect: (provider: ProviderId, key: string) => Promise<ConnectResult>;
  onModel: (provider: ProviderId, model: string) => void;
  onRemoveKey: (provider: ProviderId) => void;
  onPersist: (persist: boolean) => void;
  onClearAll: () => void;
};

export function engineSummary(prefs: Prefs, keys: Keys, connections: Props["connections"]): { label: string; ready: boolean; detail: string } {
  if (prefs.engine === "offline") return { label: "On-device", ready: true, detail: "No key needed" };
  const provider = prefs.engine;
  const conn = connections[provider];
  const model = prefs.models[provider];
  if (!keys[provider]) return { label: PROVIDERS[provider].short, ready: false, detail: "Add your key" };
  if (conn?.state === "checking") return { label: PROVIDERS[provider].short, ready: false, detail: "Checking key…" };
  if (conn?.state === "error") return { label: PROVIDERS[provider].short, ready: false, detail: "Key rejected" };
  if (!model) return { label: PROVIDERS[provider].short, ready: false, detail: "Choose a model" };
  return { label: PROVIDERS[provider].short, ready: true, detail: model };
}

export function EnginePanel({ open, onOpenChange, prefs, keys, storageOk, connections, onEngine, onConnect, onModel, onRemoveKey, onPersist, onClearAll }: Props) {
  const [draft, setDraft] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [manualModel, setManualModel] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const usingAi = prefs.engine !== "offline";
  const provider: ProviderId = prefs.engine === "offline" ? (PROVIDER_IDS.find((id) => keys[id]) ?? "google") : prefs.engine;
  const info = PROVIDERS[provider];
  const conn = connections[provider];
  const savedKey = keys[provider];
  const detected = draft ? detectProvider(draft) : null;
  const mismatch = detected && detected !== provider ? detected : null;
  const summary = engineSummary(prefs, keys, connections);
  const models = conn?.models ?? [];
  const selectedModel = prefs.models[provider] ?? "";

  useEffect(() => {
    setDraft("");
    setFeedback(null);
    setManualModel("");
  }, [provider]);

  const connect = async () => {
    setBusy(true);
    setFeedback(null);
    const result = await onConnect(provider, draft);
    setBusy(false);
    if (result.ok) setDraft("");
    setFeedback({ ok: result.ok, text: result.ok ? "Key verified and saved." : result.message });
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setDraft(sanitizeKey(text));
      else inputRef.current?.focus();
    } catch {
      inputRef.current?.focus(); // clipboard blocked: let the user paste manually
    }
  };

  return (
    <section aria-label="Summarizer engine" className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center gap-1 pr-1">
        <button type="button" onClick={() => onOpenChange(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3 p-4 text-left">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary text-primary">{usingAi ? <Sparkles className="size-5" /> : <Cpu className="size-5" />}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Engine</span>
            <span className="flex items-center gap-2 truncate text-[15px] font-semibold">
              {summary.label}
              <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", summary.ready ? "bg-primary/10 text-primary" : "bg-accent/15 text-accent")}>
                {summary.ready ? <Check className="size-3" /> : <AlertCircle className="size-3" />}
                <span className="max-w-[12rem] truncate">{summary.detail}</span>
              </span>
            </span>
          </span>
          <ChevronDown className={cn("size-5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        <InfoTip label="About privacy and keys">
          <p><strong>On-device</strong> keeps everything in this browser.</p>
          <p><strong>AI providers</strong> receive the text of the sources you include, straight from this page. Nothing goes through a server of ours.</p>
          <p>Saved keys sit in this browser’s storage and can be read by anyone with access to this device or browser — it is not a secure vault. Use a dedicated key you can revoke.</p>
        </InfoTip>
      </div>

      {open && (
        <div className="space-y-5 border-t border-border p-4">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Choose engine">
            <button type="button" role="radio" aria-checked={!usingAi} onClick={() => onEngine("offline")} className={cn("rounded-xl border p-3.5 text-left transition-colors", !usingAi ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-secondary/60")}>
              <span className="flex items-center gap-2 text-sm font-semibold"><Cpu className="size-4 text-primary" />On-device · no key</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">Works right now, fully private. Picks and groups the most important sentences from your sources.</span>
            </button>
            <button type="button" role="radio" aria-checked={usingAi} onClick={() => onEngine(provider)} className={cn("rounded-xl border p-3.5 text-left transition-colors", usingAi ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-secondary/60")}>
              <span className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-primary" />AI provider · your key</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">Smoother, rewritten summaries. Uses your own API key with the provider you pick.</span>
            </button>
          </div>

          {usingAi && (
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Provider</p>
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="AI provider">
                  {PROVIDER_IDS.map((id) => (
                    <button key={id} type="button" role="radio" aria-checked={provider === id} onClick={() => onEngine(id)} className={cn("flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors", provider === id ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-secondary")}>
                      {PROVIDERS[id].short}
                      {keys[id] && <span className={cn("size-2 rounded-full", provider === id ? "bg-primary-foreground" : "bg-primary")} aria-label="key saved" />}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl bg-secondary/60 p-3.5 text-xs leading-5 text-muted-foreground">
                <p className="font-semibold text-foreground">{info.label}</p>
                <p className="mt-1">{info.howTo}</p>
                <p className="mt-1">{info.cost}</p>
                <a href={info.keyUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 font-semibold text-primary underline-offset-2 hover:underline">
                  Get a {info.short} key <ExternalLink className="size-3" />
                </a>
              </div>

              <div className="space-y-2">
                <label htmlFor="api-key" className="flex items-center gap-1 text-sm font-medium">
                  <KeyRound className="size-4 text-muted-foreground" />
                  {info.short} API key
                </label>
                {savedKey && !draft && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-sm">
                    <span className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" />Saved · <code className="text-xs">{maskKey(savedKey)}</code></span>
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => inputRef.current?.focus()}>Replace</Button>
                      <Button size="sm" variant="ghost" onClick={() => { onRemoveKey(provider); setFeedback(null); }} aria-label={`Remove ${info.short} key`}><Trash2 />Remove</Button>
                    </span>
                  </div>
                )}
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      ref={inputRef}
                      id="api-key"
                      type={show ? "text" : "password"}
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      inputMode="text"
                      enterKeyHint="go"
                      className="h-11 pr-11 font-mono text-base"
                      placeholder={savedKey ? "Paste a new key to replace" : info.keyExample}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter" && draft.trim() && !busy) void connect(); }}
                    />
                    <button type="button" aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow((v) => !v)} className="absolute right-1 top-1 grid size-9 place-items-center rounded-md text-muted-foreground hover:text-foreground">
                      {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>
                  <Button type="button" variant="outline" className="h-11" onClick={() => void paste()}>Paste</Button>
                </div>
                {mismatch && (
                  <p className="flex flex-wrap items-center gap-2 rounded-lg bg-accent/10 px-3 py-2 text-xs leading-5" role="status">
                    <AlertCircle className="size-4 shrink-0 text-accent" />
                    <span>This looks like a <strong>{PROVIDERS[mismatch].label}</strong> key.</span>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => onEngine(mismatch)}>Switch to {PROVIDERS[mismatch].short}</Button>
                  </p>
                )}
                <Button className="h-11 w-full" disabled={!draft.trim() || busy || !!mismatch} onClick={() => void connect()}>
                  {busy ? <LoaderCircle className="animate-spin" /> : <Check />}
                  {busy ? "Checking key…" : "Verify & save key"}
                </Button>
                {feedback && (
                  <p role={feedback.ok ? "status" : "alert"} className={cn("flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-5", feedback.ok ? "bg-primary/10 text-foreground" : "bg-destructive/10 text-foreground")}>
                    {feedback.ok ? <Check className="mt-0.5 size-4 shrink-0 text-primary" /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
                    <span>{feedback.text}</span>
                  </p>
                )}
              </div>

              {savedKey && (
                <div className="space-y-2">
                  <label htmlFor="model" className="text-sm font-medium">{info.short} model</label>
                  {conn?.state === "checking" && <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading {info.short} models…</p>}
                  {models.length > 0 && (
                    <div className="relative">
                      <select id="model" value={selectedModel} onChange={(event) => onModel(provider, event.target.value)} className="h-11 w-full appearance-none rounded-md border border-input bg-background px-3 pr-10 text-base">
                        {!models.some((m) => m.id === selectedModel) && <option value="">Choose a model…</option>}
                        {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-3.5 size-4 text-muted-foreground" />
                    </div>
                  )}
                  {models.length > 0 && <p className="text-xs text-muted-foreground">Showing the {models.length} models available to your {info.short} key only.</p>}
                  {conn && conn.state !== "ok" && conn.state !== "checking" && (
                    <div className="space-y-2">
                      <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs leading-5"><AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />{conn.message}</p>
                      {conn.state === "unverified" && (
                        <div className="flex gap-2">
                          <Input className="h-11 text-base" placeholder="Type a model ID, e.g. gemini-2.5-flash" value={manualModel} onChange={(e) => setManualModel(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                          <Button variant="outline" className="h-11" disabled={!manualModel.trim()} onClick={() => { onModel(provider, manualModel.trim()); setManualModel(""); }}>Use</Button>
                        </div>
                      )}
                      {conn.state === "unverified" && selectedModel && <p className="text-xs text-muted-foreground">Using model: <code>{selectedModel}</code></p>}
                    </div>
                  )}
                  {conn?.state === "ok" && !selectedModel && <p className="text-xs text-accent">Pick a model to continue.</p>}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex items-center gap-3 text-sm">
              <Switch checked={prefs.persist} onCheckedChange={onPersist} aria-label="Remember keys on this device" />
              <span>
                Remember keys on this device
                <span className="block text-xs text-muted-foreground">{prefs.persist ? "Kept until you remove them." : "Forgotten when this tab closes."}</span>
              </span>
            </label>
            {Object.keys(keys).length > 0 && <Button variant="ghost" size="sm" className="self-start text-destructive hover:text-destructive sm:self-auto" onClick={onClearAll}><Trash2 />Remove all keys</Button>}
          </div>
          {!storageOk && <p className="text-xs text-accent" role="alert">This browser blocked saving settings (private mode?). Keys will be lost when you leave the page.</p>}
        </div>
      )}
    </section>
  );
}
