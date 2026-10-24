// Reads from ClickHouse over its HTTP interface (port 8123). No client library needed.
// Values are passed as query parameters ({name:Type} in the SQL, param_name=value in the URL),
// so user input never gets pasted into the SQL text.
const URL_BASE = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
const USER = process.env.CLICKHOUSE_USER ?? "default";
const PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "dev";

export type Params = Record<string, string | number>;

async function send(sql: string, params: Params, extra: Record<string, string>): Promise<string> {
  const search = new URLSearchParams({ database: "otel", ...extra });
  for (const [name, value] of Object.entries(params)) search.set(`param_${name}`, String(value));

  const response = await fetch(`${URL_BASE}/?${search}`, {
    method: "POST",
    body: sql,
    headers: { Authorization: "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64") },
    cache: "no-store", // always fresh data; this is a monitoring page
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse error ${response.status}: ${text.slice(0, 300)}`);
  return text;
}

/** Run a SELECT and return the rows as objects. */
export async function query<T>(sql: string, params: Params = {}): Promise<T[]> {
  const text = await send(sql, params, {
    default_format: "JSONEachRow",
    output_format_json_quote_64bit_integers: "0", // send big numbers as numbers, not strings
  });
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** Run a statement that returns nothing (for example ALTER TABLE ... UPDATE). */
export async function command(sql: string, params: Params = {}): Promise<void> {
  await send(sql, params, {});
}
