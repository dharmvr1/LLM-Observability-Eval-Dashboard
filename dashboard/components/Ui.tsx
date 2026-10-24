// Small server-side building blocks used by several pages.
import Link from "next/link";
import { RANGES, type Filters, type RangeKey } from "@/lib/range";

export function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "good" | "bad" }) {
  return (
    <div className={`tile ${tone ?? ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}

/** Time-range chips and the "include demo data" switch. Keeps the other query parameters. */
export function Toolbar({ path, filters, extra = {}, showDemo = true }: { path: string; filters: Filters; extra?: Record<string, string>; showDemo?: boolean }) {
  const link = (range: RangeKey, demo: boolean) => {
    const params = new URLSearchParams({ ...extra, range });
    if (demo) params.set("demo", "1");
    return `${path}?${params}`;
  };
  return (
    <div className="toolbar">
      <div className="chips">
        {(Object.keys(RANGES) as RangeKey[]).map((key) => (
          <Link key={key} href={link(key, filters.demo)} className={`chip ${key === filters.range ? "on" : ""}`}>
            {RANGES[key].label}
          </Link>
        ))}
      </div>
      {showDemo ? (
        <Link href={link(filters.range, !filters.demo)} className={`chip ${filters.demo ? "on" : ""}`}>
          {filters.demo ? "demo data: shown" : "demo data: hidden"}
        </Link>
      ) : null}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === "Error" ? "bad" : status === "Ok" || status === "Unset" ? "good" : "muted";
  return <span className={`badge ${tone}`}>{status === "Unset" ? "ok" : status.toLowerCase()}</span>;
}
