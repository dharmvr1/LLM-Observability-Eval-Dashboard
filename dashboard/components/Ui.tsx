// Server-side building blocks shared by the pages.
import Link from "next/link";
import { RANGES, type Filters, type RangeKey } from "@/lib/range";
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle, Inbox, Minus, MinusCircle, XCircle } from "./Icons";
import Sparkline from "./Sparkline";

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="sub">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** The one filter row above the content it scopes: time range, plus the "include demo data" switch. */
export function Toolbar({ path, filters, extra = {}, showDemo = true }: { path: string; filters: Filters; extra?: Record<string, string>; showDemo?: boolean }) {
  const link = (range: RangeKey, demo: boolean) => {
    const params = new URLSearchParams({ ...extra, range });
    if (demo) params.set("demo", "1");
    return `${path}?${params}`;
  };
  return (
    <div className="toolbar">
      <div className="segmented" role="group" aria-label="Time range">
        {(Object.keys(RANGES) as RangeKey[]).map((key) => (
          <Link key={key} href={link(key, filters.demo)} className={key === filters.range ? "on" : ""} aria-current={key === filters.range ? "true" : undefined}>
            {RANGES[key].short}
          </Link>
        ))}
      </div>
      {showDemo ? (
        <Link href={link(filters.range, !filters.demo)} className={`chip ${filters.demo ? "on" : ""}`}>
          {filters.demo ? "Demo data shown" : "Demo data hidden"}
        </Link>
      ) : null}
    </div>
  );
}

/** Change against the previous period. The color is direction times "is up good?"; an arrow and a sign always come with it. */
export function Delta({ current, previous, upIsGood, vs }: { current: number; previous: number | null; upIsGood?: boolean; vs: string }) {
  // Nothing to compare with: say nothing, rather than repeating "no earlier data" on every tile.
  if (previous === null || previous === 0 || !Number.isFinite(previous)) return null;
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return <span className="delta flat"><Minus />no change<span className="vs">{vs}</span></span>;
  const up = change > 0;
  const tone = upIsGood === undefined ? "flat" : up === upIsGood ? "good" : "bad";
  return (
    <span className={`delta ${tone}`}>
      {up ? <ArrowUp /> : <ArrowDown />}
      {up ? "+" : "-"}{Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%<span className="vs">{vs}</span>
    </span>
  );
}

export function Tile({ label, value, note, delta, spark }: { label: string; value: string; note?: string; delta?: React.ReactNode; spark?: number[] }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta ?? (note ? <div className="note">{note}</div> : null)}
      {delta && note ? <div className="note">{note}</div> : null}
      {spark && spark.length > 1 ? <div className="spark"><Sparkline values={spark} /></div> : null}
    </div>
  );
}

export type Tone = "good" | "warn" | "bad" | "none";
const ICONS = { good: CheckCircle, warn: AlertTriangle, bad: XCircle, none: MinusCircle } as const;

/** One line of system health: an icon, a title and what it means. Never color alone. */
export function HealthItem({ tone, title, detail, href }: { tone: Tone; title: string; detail: string; href: string }) {
  const Icon = ICONS[tone];
  return (
    <Link href={href} className="health-item">
      <span className={`dot-icon ${tone}`}><Icon size={18} /></span>
      <span><div className="t">{title}</div><div className="d">{detail}</div></span>
    </Link>
  );
}

export function Banner({ tone, children }: { tone: "ok" | "attention" | "critical"; children: React.ReactNode }) {
  const Icon = tone === "ok" ? CheckCircle : tone === "attention" ? AlertTriangle : XCircle;
  const color = tone === "ok" ? "var(--good-text)" : tone === "attention" ? "var(--warning-text)" : "var(--critical)";
  return <div className={`banner ${tone}`}><span style={{ color, display: "grid" }}><Icon size={20} /></span><span>{children}</span></div>;
}

export function StatusBadge({ status }: { status: string }) {
  if (status === "Error") return <span className="badge bad"><XCircle size={12} />error</span>;
  return <span className="badge good"><CheckCircle size={12} />ok</span>;
}

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const Icon = ICONS[tone];
  return <span className={`badge ${tone === "none" ? "muted" : tone}`}><Icon size={12} />{children}</span>;
}

/** A meter: the fill is the value; the track is a lighter step of the same hue. `mark` draws a threshold tick. */
export function Meter({ value, max = 1, mark, severity }: { value: number; max?: number; mark?: number; severity?: "warn" | "bad" }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="meter-wrap">
      <div className={`meter ${severity ?? ""}`} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}><span style={{ width: `${pct}%` }} /></div>
      {mark !== undefined ? <div className="meter-mark" style={{ left: `calc(${(mark / max) * 100}% - 1px)` }} title={`threshold ${mark}`} /> : null}
    </div>
  );
}

/** Horizontal bars for nominal categories: one color, thin bars, the value at the tip.
 *  `mark` draws a threshold tick; a row with `alert` gets a warning icon and the word "drifting" next to its value. */
export function BarList({ rows, mark, alertLabel = "drifting" }: { rows: { name: string; value: number; display: string; alert?: boolean }[]; mark?: { value: number; label: string }; alertLabel?: string }) {
  const max = Math.max(...rows.map((r) => r.value), mark?.value ?? 0, 0) || 1;
  if (rows.length === 0) return <Empty title="Nothing to show" hint="No data in this range." />;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.name}>
          <div className="name" title={r.name}>{r.name}</div>
          <div className="track">
            <div className="fill" style={{ width: `${(r.value / max) * 100}%` }} />
            {mark ? <div className="tick" style={{ left: `${(mark.value / max) * 100}%` }} title={mark.label} /> : null}
          </div>
          <div className="val">
            {r.alert ? <span className="flag"><AlertTriangle size={13} />{alertLabel}</span> : null}
            {r.display}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <Inbox />
      <div style={{ color: "var(--ink-2)", fontWeight: 600 }}>{title}</div>
      {hint ? <div style={{ fontSize: 13 }}>{hint}</div> : null}
    </div>
  );
}
