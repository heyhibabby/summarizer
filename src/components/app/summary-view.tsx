import { Fragment, type ReactNode } from "react";

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[\d+(?:[,\s]*\d+)*\])/g).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^\[\d+(?:[,\s]*\d+)*\]$/.test(part)) return <sup key={i} className="ml-0.5 text-[0.7em] font-semibold text-accent">{part}</sup>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** Minimal Markdown view for the summary (headings, bullets, paragraphs, bold, [n] citations). */
export function SummaryView({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = (key: string) => {
    if (!list.length) return;
    blocks.push(<ul key={key} className="my-2 list-disc space-y-1.5 pl-5">{list.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>);
    list = [];
  };
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) {
      list.push(line.replace(/^[-*•]\s+/, ""));
      return;
    }
    flush(`l${index}`);
    if (!line) return;
    if (/^#\s+/.test(line)) blocks.push(<h3 key={index} className="mb-3 font-serif text-2xl font-semibold leading-snug">{inline(line.replace(/^#\s+/, ""))}</h3>);
    else if (/^###\s+/.test(line)) blocks.push(<h5 key={index} className="mb-1 mt-4 text-base font-semibold">{inline(line.replace(/^#+\s+/, ""))}</h5>);
    else if (/^##+\s+/.test(line)) blocks.push(<h4 key={index} className="mb-1 mt-5 text-xs font-bold uppercase tracking-wider text-accent">{inline(line.replace(/^#+\s+/, ""))}</h4>);
    else if (/^\d+\.\s+/.test(line)) blocks.push(<p key={index} className="text-sm text-muted-foreground">{line}</p>);
    else blocks.push(<p key={index} className="my-2">{inline(line)}</p>);
  });
  flush("end");
  return <div className="text-[15px] leading-7">{blocks}</div>;
}
