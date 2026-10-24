// The time ranges offered on the pages. The SQL pieces come from this fixed list, never from the URL.
export type RangeKey = "1h" | "24h" | "7d" | "30d";

export const RANGES: Record<RangeKey, { label: string; interval: string; bucketMinutes: number; seconds: number }> = {
  "1h": { label: "last hour", interval: "1 HOUR", bucketMinutes: 1, seconds: 3600 },
  "24h": { label: "last 24 hours", interval: "24 HOUR", bucketMinutes: 15, seconds: 86400 },
  "7d": { label: "last 7 days", interval: "7 DAY", bucketMinutes: 120, seconds: 7 * 86400 },
  "30d": { label: "last 30 days", interval: "30 DAY", bucketMinutes: 1440, seconds: 30 * 86400 },
};

export type Filters = { range: RangeKey; demo: boolean };

type SearchParams = Record<string, string | string[] | undefined>;

export function readFilters(searchParams: SearchParams): Filters {
  const raw = Array.isArray(searchParams.range) ? searchParams.range[0] : searchParams.range;
  const range = (raw && raw in RANGES ? raw : "24h") as RangeKey;
  return { range, demo: searchParams.demo === "1" };
}

/** SQL condition for spans: inside the time range, and (by default) without the fake drift-demo apps. */
export function spanCondition(filters: Filters): string {
  const parts = [`start_time > now() - INTERVAL ${RANGES[filters.range].interval}`];
  if (!filters.demo) parts.push("app_id NOT LIKE 'drift-demo-%'");
  return parts.join(" AND ");
}

export function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}
