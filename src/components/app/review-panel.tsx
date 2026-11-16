import { AlertTriangle, BarChart3, Check, Image as ImageIcon, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InfoTip } from "@/components/app/info-tip";
import type { Finding, SourceRecord, TopicAnalysis } from "@/lib/summarizer";

type Props = {
  sources: SourceRecord[];
  included: (id: string) => boolean;
  topics: TopicAnalysis;
  onFinding: (sourceId: string, findingId: string, included: boolean) => void;
  onAllFindings: (included: boolean) => void;
  onToggleSource: (id: string, included: boolean) => void;
};

const KindIcon = ({ kind }: { kind: Finding["kind"] }) => (kind === "table" ? <Table2 className="size-4" /> : kind === "chart" ? <BarChart3 className="size-4" /> : <ImageIcon className="size-4" />);

export function ReviewPanel({ sources, included, topics, onFinding, onAllFindings, onToggleSource }: Props) {
  const flagged = sources.filter((s) => topics.outliers.includes(s.id));
  const findings = sources.filter((s) => included(s.id)).flatMap((s) => s.findings.map((f) => ({ ...f, sourceId: s.id, sourceName: s.name })));
  return (
    <section aria-label="Review" className="space-y-5">
      {sources.length > 1 && (
        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-1">
            <h3 className="text-sm font-semibold">Topic check</h3>
            <InfoTip label="About the topic check"><p>Compares the vocabulary of each source with the others. A source that differs from most of the others is flagged so you can include or exclude it before summarizing.</p><p>It is a simple word-overlap comparison, not true understanding.</p></InfoTip>
          </div>
          {flagged.length === 0 && !topics.pairWarning && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Check className="size-4 text-primary" />Your sources appear to cover similar topics.</p>}
          {topics.pairWarning && <p className="flex items-start gap-2 rounded-lg bg-accent/10 p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent" />These two sources look like they cover different topics. Merging them may give a mixed summary — remove one if that is not what you want.</p>}
          {flagged.map((s) => (
            <div key={s.id} className="mt-2 flex items-start gap-2 rounded-lg bg-accent/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <p><strong className="break-words">{s.name}</strong> seems to be on a different topic than the majority.</p>
                <label className="mt-2 flex items-center gap-2 text-xs"><Checkbox checked={included(s.id)} onCheckedChange={(c) => onToggleSource(s.id, c === true)} />Include it anyway</label>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-2 flex items-center gap-1">
          <h3 className="text-sm font-semibold">Images, tables &amp; charts</h3>
          <InfoTip label="About visual findings"><p>Found from text only: captions like “Figure 2”, tables, embedded image markers, and sentences pointing at them. Pictures themselves cannot be read.</p><p>Untick an item to leave it out of the summary input.</p></InfoTip>
          <span className="ml-auto text-xs text-muted-foreground">{findings.length} found</span>
        </div>
        {findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">None detected in the included sources.</p>
        ) : (
          <>
            <div className="mb-2 flex gap-1">
              <Button variant="outline" size="sm" onClick={() => onAllFindings(true)}>Include all</Button>
              <Button variant="outline" size="sm" onClick={() => onAllFindings(false)}>Exclude all</Button>
            </div>
            <ul className="max-h-64 divide-y divide-border overflow-auto">
              {findings.map((f) => (
                <li key={`${f.sourceId}-${f.id}`}>
                  <label className="flex cursor-pointer items-start gap-2.5 py-2.5 text-xs leading-5">
                    <Checkbox className="mt-0.5" checked={f.included} onCheckedChange={(c) => onFinding(f.sourceId, f.id, c === true)} />
                    <span className="mt-0.5 text-primary"><KindIcon kind={f.kind} /></span>
                    <span className="min-w-0"><span className="block truncate text-[11px] text-muted-foreground">{f.sourceName}</span>{f.excerpt}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
