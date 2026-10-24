"use client";

// Recharts draws in the browser, so this file is a client component. The pages (server side)
// run the SQL and pass plain arrays of numbers in.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type Series = { key: string; name: string; color: string };
type Row = { t: number } & Record<string, number | null>;

type Props = {
  data: Row[];
  series: Series[];
  kind?: "line" | "bar";
  threshold?: { value: number; label: string };
  logScale?: boolean; // for values that span orders of magnitude, like PSI
  unit?: string;      // appended in the tooltip, for example " ms"
  bucketMinutes?: number; // size of one point; decides how the time labels look
};

// Labels that fit the size of one bucket: 15 minutes -> "14:30", 2 hours -> "10-23 14:00", a day -> "10-23".
function timeLabel(t: number, bucketMinutes: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const clock = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (bucketMinutes >= 1440) return day;
  if (bucketMinutes >= 120) return `${day} ${clock}`;
  return clock;
}

export default function TimeChart({ data, series, kind = "line", threshold, logScale, unit = "", bucketMinutes = 15 }: Props) {
  if (data.length === 0) return <div className="empty">No data in this range.</div>;
  // Bars need a category axis (one slot per bucket) to get a visible width; lines use a real time axis.
  const labelled = data.map((row) => ({ ...row, label: timeLabel(row.t, bucketMinutes) }));
  const lineAxis = {
    dataKey: "t",
    type: "number" as const,
    scale: "time" as const,
    domain: ["dataMin", "dataMax"] as [string, string],
    tickFormatter: (t: number) => timeLabel(t, bucketMinutes),
    stroke: "var(--muted)",
    fontSize: 12,
  };
  const barAxis = { dataKey: "label", stroke: "var(--muted)", fontSize: 12, minTickGap: 24 };
  const yAxis = (
    <YAxis
      stroke="var(--muted)"
      fontSize={12}
      width={48}
      {...(logScale
        ? { scale: "log" as const, domain: [0.01, (max: number) => Math.max(10, max)] as [number, (max: number) => number], ticks: [0.01, 0.1, 1, 10], allowDataOverflow: true }
        : {})}
    />
  );
  const tooltip = (
    <Tooltip
      labelFormatter={(label, items) => {
        const t = items?.[0]?.payload?.t;
        return typeof t === "number" ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : String(label);
      }}
      formatter={(value) => [`${typeof value === "number" ? Math.round(value * 1000) / 1000 : value}${unit}`]}
      contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8 }}
    />
  );
  const legend = series.length > 1 ? <Legend /> : null;
  const ref = threshold ? (
    <ReferenceLine y={threshold.value} stroke="var(--bad)" strokeDasharray="5 4" label={{ value: threshold.label, fill: "var(--bad)", fontSize: 12, position: "insideTopRight" }} />
  ) : null;

  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height="100%">
        {kind === "bar" ? (
          <BarChart data={labelled}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis {...barAxis} />
            {yAxis}
            {tooltip}
            {legend}
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} />
            ))}
          </BarChart>
        ) : (
          <LineChart data={data}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis {...lineAxis} />
            {yAxis}
            {tooltip}
            {legend}
            {ref}
            {series.map((s) => (
              <Line key={s.key} dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={data.length < 25} connectNulls />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
