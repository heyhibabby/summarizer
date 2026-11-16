import { BarChart3, ImageIcon, Table2, TriangleAlert } from "lucide-react";
import type { SummarySection } from "@/lib/pipeline";
import type { Visual } from "@/lib/visuals";

const Icon = ({ kind }: { kind: Visual["kind"] }) => (kind === "table" ? <Table2 className="size-4" /> : kind === "figure" ? <BarChart3 className="size-4" /> : <ImageIcon className="size-4" />);

export function OutlineView({ outline, title, multi }: { outline: SummarySection[]; title: string; multi: boolean }) {
  let lastSource = -1;
  return (
    <div className="space-y-7">
      <h3 className="font-serif text-2xl font-semibold leading-snug">{title}</h3>
      {outline.map((section, index) => {
        const showSource = multi && section.sourceIndex !== lastSource;
        lastSource = section.sourceIndex;
        return (
          <section key={section.id} aria-label={section.title}>
            {showSource && <p className="mb-3 border-b border-border pb-1.5 text-xs font-bold uppercase tracking-wider text-accent">{section.sourceName}</p>}
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 font-mono text-xs font-semibold text-primary">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <h4 className="text-lg font-semibold leading-snug">{section.title}</h4>
                {section.pages && <p className="text-xs text-muted-foreground">{section.pages}</p>}
                {section.failed ? (
                  <p className="mt-2 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />This chapter could not be summarized ({section.failed}). Tap Regenerate to try again.</p>
                ) : (
                  <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] leading-7 marker:text-accent">{section.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
                )}
                {section.visuals.length > 0 && (
                  <div className="mt-4 space-y-3 rounded-xl bg-secondary/50 p-3">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Tables &amp; figures in this chapter</p>
                    {section.visuals.map((v, i) => (
                      <figure key={i} className="space-y-2">
                        <figcaption className="flex items-start gap-2 text-sm"><span className="mt-0.5 text-primary"><Icon kind={v.kind} /></span><span>{v.caption}{v.page ? <span className="text-muted-foreground"> · page {v.page}</span> : null}</span></figcaption>
                        {v.image && <img src={v.image} alt={`Snapshot of page ${v.page ?? ""}: ${v.caption}`} loading="lazy" className="w-full max-w-md rounded-lg border border-border bg-white" />}
                      </figure>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
