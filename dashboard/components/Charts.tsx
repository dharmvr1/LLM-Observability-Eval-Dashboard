"use client";

// Recharts draws in the browser, so this file is a client component. The pages (server side) run the SQL
// and pass plain arrays in. Anything passed in must be serialisable, so number formats are chosen by NAME
// and the functions live here.
//
// Mark specs (dataviz skill): lines 2 px, bars at most 24 px thick with 4 px rounded data ends and a 2 px
// surface gap, an area is a ~10% wash, one hairline solid grid, dots at least 8 px with a 2 px surface ring.
import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type Series = { key: string; name: string; color: string };
type Row = { t: number } & Record<string, number | null>;
export type Format = "int" | "compact" | "ms" | "pct" | "score" | "psi" | "usd";

const FORMATS: Record<Format, (n: number) => string> = {
  int: (n) => Math.round(n).toLocaleString("en-US"),
  compact: (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K` : String(Math.round(n * 10) / 10)),
  ms: (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} s` : `${Math.round(n)} ms`),
  pct: (n) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`,
  score: (n) => n.toFixed(2),
  psi: (n) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2)),
  usd: (n) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`),
};

// "14:30" for short buckets, "10-23 14:00" for 2-hour buckets, "10-23" for daily ones.
function timeLabel(t: number, bucketMinutes: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const clock = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (bucketMinutes >= 1440) return day;
  if (bucketMinutes >= 120) return `${day} ${clock}`;
  return clock;
}

function fullTime(t: number): string {
  return new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

type TooltipProps = {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | null; payload?: Row }[];
  series: Series[]; format: Format; line: boolean;
};

// One tooltip for every series at that X. The value leads, the name follows; rows are keyed with a short line.
function ChartTooltip({ active, payload, series, format, line }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const t = payload[0].payload?.t;
  return (
    <div className="tooltip">
      {typeof t === "number" ? <div className="when">{fullTime(t)}</div> : null}
      {series.map((s) => {
        const hit = payload.find((p) => p.dataKey === s.key);
        if (!hit || hit.value === null || hit.value === undefined) return null;
        return (
          <div className="row" key={s.key}>
            <span className={line ? "key-line" : "key-box"} style={{ background: s.color }} />
            <span className="nm">{s.name}</span>
            <b>{FORMATS[format](hit.value)}</b>
          </div>
        );
      })}
    </div>
  );
}

type Props = {
  data: Row[]; series: Series[];
  kind?: "line" | "area" | "bar"; stacked?: boolean;
  format?: Format; axisFormat?: Format;
  threshold?: { value: number; label: string };
  logScale?: boolean; yDomain?: [number, number];
  bucketMinutes?: number; height?: number; ariaLabel: string;
};

export default function TimeChart({
  data, series, kind = "line", stacked = false, format = "int", axisFormat, threshold, logScale, yDomain, bucketMinutes = 15, height = 250, ariaLabel,
}: Props) {
  if (data.length === 0) return <div className="empty">No data in this range.</div>;

  const isBar = kind === "bar";
  const axisFmt = FORMATS[axisFormat ?? format];
  const labelled = data.map((row) => ({ ...row, label: timeLabel(row.t, bucketMinutes) }));
  const xAxis = isBar ? (
    <XAxis dataKey="label" stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 12 }} tickLine={false} minTickGap={28} />
  ) : (
    <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => timeLabel(t, bucketMinutes)}
      stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 12 }} tickLine={false} minTickGap={36} />
  );
  const yAxis = (
    <YAxis width={58} stroke="none" tick={{ fill: "var(--muted)", fontSize: 12 }} tickLine={false} tickFormatter={(v: number) => axisFmt(v)}
      {...(logScale ? { scale: "log" as const, domain: [0.01, (max: number) => Math.max(10, max)] as [number, (m: number) => number], ticks: [0.01, 0.1, 1, 10], allowDataOverflow: true } : yDomain ? { domain: yDomain } : {})} />
  );
  const grid = <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />;
  const tooltip = (
    <Tooltip content={<ChartTooltip series={series} format={format} line={!isBar} />}
      cursor={isBar ? { fill: "var(--hover)" } : { stroke: "var(--axis)", strokeWidth: 1 }} isAnimationActive={false} />
  );
  const ref = threshold ? (
    <ReferenceLine y={threshold.value} stroke="var(--critical)" strokeWidth={1.5} strokeDasharray="0"
      label={{ value: threshold.label, fill: "var(--ink-2)", fontSize: 12, position: "insideTopRight" }} />
  ) : null;
  const margin = { top: 8, right: 14, bottom: 0, left: 0 };
  const lastIndex = data.length - 1;

  // a dot only at the latest point of a line, with a 2 px ring in the surface color
  const endDot = (color: string) => (p: { cx?: number; cy?: number; index?: number }) =>
    p.index === lastIndex && p.cx !== undefined && p.cy !== undefined ? (
      <circle key={`end-${p.index}`} cx={p.cx} cy={p.cy} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
    ) : (
      <g key={`none-${p.index}`} />
    );
  const active = (color: string) => ({ r: 4.5, fill: color, stroke: "var(--surface)", strokeWidth: 2 });

  let chart: React.ReactElement;
  if (isBar) {
    chart = (
      <BarChart data={labelled} margin={margin} barCategoryGap="22%">
        {grid}{xAxis}{yAxis}{tooltip}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} maxBarSize={24} isAnimationActive={false}
            stackId={stacked ? "stack" : undefined} stroke={stacked ? "var(--surface)" : undefined} strokeWidth={stacked ? 2 : 0}
            radius={stacked ? (i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]) : [4, 4, 0, 0]} />
        ))}
      </BarChart>
    );
  } else if (kind === "area" && series.length === 1) {
    const s = series[0];
    chart = (
      <AreaChart data={data} margin={margin}>
        {grid}{xAxis}{yAxis}{tooltip}{ref}
        <Area type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.1}
          dot={endDot(s.color)} activeDot={active(s.color)} isAnimationActive={false} connectNulls />
      </AreaChart>
    );
  } else {
    chart = (
      <LineChart data={data} margin={margin}>
        {grid}{xAxis}{yAxis}{tooltip}{ref}
        {series.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
            dot={endDot(s.color)} activeDot={active(s.color)} isAnimationActive={false} connectNulls />
        ))}
      </LineChart>
    );
  }

  return (
    <div className="chart" role="img" aria-label={ariaLabel}>
      {series.length > 1 ? (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key}><i className={isBar ? "key-box" : "key-line"} style={{ background: s.color }} />{s.name}</span>
          ))}
        </div>
      ) : null}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Stacked horizontal bars that show where time goes (the five stages of the alert pipeline).
// One hue in five steps (an ordinal ramp, validated); a 2 px surface gap between segments.
// ------------------------------------------------------------------------------------------------
export type StageRow = { label: string; note: string; stages: number[]; total: number; ok: boolean };

export function StageBars({ rows, stageNames }: { rows: StageRow[]; stageNames: string[] }) {
  const [tip, setTip] = useState<{ x: number; y: number; row: string; stage: string; seconds: number; color: string } | null>(null);
  const max = Math.max(...rows.map((r) => r.total), 1);
  const colors = ["var(--o1)", "var(--o2)", "var(--o3)", "var(--o4)", "var(--o5)"];
  return (
    <div className="chart" style={{ position: "relative" }} onMouseLeave={() => setTip(null)}>
      <div className="legend">
        {stageNames.map((name, i) => (<span key={name}><i className="key-box" style={{ background: colors[i] }} />{name}</span>))}
      </div>
      {rows.map((row) => (
        <div className="stage-row" key={row.label}>
          <div><div style={{ fontWeight: 600 }}>{row.label}</div><div className="muted" style={{ fontSize: 12 }}>{row.note}</div></div>
          <div className="stages" style={{ width: `${(row.total / max) * 100}%`, minWidth: 40 }}>
            {row.stages.map((seconds, i) =>
              seconds > 0 ? (
                <div key={i} style={{ background: colors[i], flexGrow: seconds, flexBasis: 0 }}
                  onMouseMove={(e) => {
                    const box = e.currentTarget.closest(".chart")!.getBoundingClientRect();
                    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, row: row.label, stage: stageNames[i], seconds, color: colors[i] });
                  }}
                  tabIndex={0} aria-label={`${row.label}, ${stageNames[i]}: ${seconds.toFixed(0)} seconds`} />
              ) : null,
            )}
          </div>
          <div className="num" style={{ fontWeight: 650, textAlign: "right" }}>{row.total.toFixed(0)} s</div>
        </div>
      ))}
      {tip ? (
        <div className="tooltip" style={{ position: "absolute", left: Math.min(tip.x + 12, 520), top: tip.y + 12, zIndex: 5 }}>
          <div className="when">{tip.row}</div>
          <div className="row"><span className="key-box" style={{ background: tip.color }} /><span className="nm">{tip.stage}</span><b>{tip.seconds.toFixed(1)} s</b></div>
        </div>
      ) : null}
    </div>
  );
}
