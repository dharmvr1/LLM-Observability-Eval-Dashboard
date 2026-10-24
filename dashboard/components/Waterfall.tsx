// A waterfall: one row per span, a bar placed by when the span started and how long it ran.
// Pure HTML/CSS, so it needs no chart library.
import { ms } from "@/lib/format";

export type WaterfallSpan = {
  span_id: string;
  parent_span_id: string;
  name: string;
  start_ms: number;
  latency_ms: number;
  status: string;
  model: string;
};

export default function Waterfall({ spans }: { spans: WaterfallSpan[] }) {
  const byId = new Map(spans.map((s) => [s.span_id, s]));

  // depth = number of parents above the span (a missing parent counts as a root)
  const depth = (span: WaterfallSpan): number => {
    let d = 0;
    let parent = byId.get(span.parent_span_id);
    while (parent && d < 20) {
      d += 1;
      parent = byId.get(parent.parent_span_id);
    }
    return d;
  };

  // order: each parent followed by its children, children sorted by start time
  const children = new Map<string, WaterfallSpan[]>();
  for (const span of spans) {
    const key = byId.has(span.parent_span_id) ? span.parent_span_id : "";
    children.set(key, [...(children.get(key) ?? []), span]);
  }
  const ordered: WaterfallSpan[] = [];
  const visit = (key: string) => {
    for (const span of (children.get(key) ?? []).sort((a, b) => a.start_ms - b.start_ms)) {
      ordered.push(span);
      visit(span.span_id);
    }
  };
  visit("");

  const start = Math.min(...spans.map((s) => s.start_ms));
  const end = Math.max(...spans.map((s) => s.start_ms + s.latency_ms));
  const total = Math.max(end - start, 1);

  return (
    <div className="waterfall">
      {ordered.map((span) => {
        const left = ((span.start_ms - start) / total) * 100;
        const width = Math.max((span.latency_ms / total) * 100, 0.8);
        return (
          <div className="wf-row" key={span.span_id}>
            <div className="wf-name" style={{ paddingLeft: depth(span) * 16 }} title={span.name}>
              {span.name}
              {span.model ? <span style={{ color: "var(--muted)" }}> · {span.model}</span> : null}
            </div>
            <div className="wf-track">
              <div className={`wf-bar ${span.status === "Error" ? "err" : ""}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
            </div>
            <div className="wf-time">{ms(span.latency_ms)}</div>
          </div>
        );
      })}
    </div>
  );
}
