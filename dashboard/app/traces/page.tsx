import Link from "next/link";
import { StatusBadge, Toolbar } from "@/components/Ui";
import { query } from "@/lib/db";
import { lastMessage, maskSensitive, ms, num, when } from "@/lib/format";
import { first, readFilters, spanCondition } from "@/lib/range";

export const dynamic = "force-dynamic";

type Row = {
  started: string; trace_id: string; name: string; app_id: string; user_id: string; model: string;
  latency_ms: number; tin: number; tout: number; status: string; input: string; output: string;
};

export default async function Traces({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const filters = readFilters(sp);
  const q = first(sp.q).trim();
  const app = first(sp.app);
  const user = first(sp.user).trim();
  const onlyErrors = first(sp.errors) === "1";

  // Each filter adds a fixed SQL fragment; the values go in as bound parameters ({name:Type}).
  const conditions = [spanCondition(filters), "gen_ai_request_model != ''"];
  const params: Record<string, string> = {};
  if (q) {
    conditions.push("(positionCaseInsensitive(attributes['gen_ai.input.messages'], {q:String}) > 0 OR positionCaseInsensitive(attributes['gen_ai.output.messages'], {q:String}) > 0)");
    params.q = q;
  }
  if (app) { conditions.push("app_id = {app:String}"); params.app = app; }
  if (user) { conditions.push("user_id = {user:String}"); params.user = user; }
  if (onlyErrors) conditions.push("status = 'Error'");

  const [rows, apps] = await Promise.all([
    query<Row>(
      `SELECT toString(start_time) AS started, trace_id, name, app_id, user_id, gen_ai_request_model AS model, latency_ms,
              input_tokens AS tin, output_tokens AS tout, status,
              attributes['gen_ai.input.messages'] AS input, attributes['gen_ai.output.messages'] AS output
       FROM spans WHERE ${conditions.join(" AND ")} ORDER BY start_time DESC LIMIT 100`,
      params,
    ),
    query<{ app_id: string }>(`SELECT DISTINCT app_id FROM spans WHERE ${spanCondition(filters)} ORDER BY app_id`),
  ]);

  const extra: Record<string, string> = {};
  if (q) extra.q = q;
  if (app) extra.app = app;
  if (user) extra.user = user;
  if (onlyErrors) extra.errors = "1";

  return (
    <>
      <h1>Traces</h1>
      <p className="sub">One row per LLM call, newest first (at most 100). Click a row for the waterfall, the prompt and the scores.</p>
      <Toolbar path="/traces" filters={filters} extra={extra} />

      <form className="search" action="/traces">
        <input name="q" defaultValue={q} placeholder="search prompt or answer text" size={30} />
        <select name="app" defaultValue={app}>
          <option value="">all apps</option>
          {apps.map((a) => <option key={a.app_id} value={a.app_id}>{a.app_id}</option>)}
        </select>
        <input name="user" defaultValue={user} placeholder="user id" size={10} />
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" name="errors" value="1" defaultChecked={onlyErrors} /> errors only
        </label>
        <input type="hidden" name="range" value={filters.range} />
        {filters.demo ? <input type="hidden" name="demo" value="1" /> : null}
        <button className="primary" type="submit">Search</button>
      </form>

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">No calls match.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th><th>App</th><th>User</th><th>Model</th><th className="num">Latency</th>
                <th className="num">Tokens</th><th>Status</th><th>Prompt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.trace_id}-${i}`}>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}><Link href={`/traces/${r.trace_id}`}>{when(r.started)}</Link></td>
                  <td>{r.app_id}</td>
                  <td>{r.user_id || "-"}</td>
                  <td>{r.model}</td>
                  <td className="num">{ms(r.latency_ms)}</td>
                  <td className="num">{num(r.tin + r.tout)}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="clip" title={maskSensitive(lastMessage(r.input, "user"))}>{maskSensitive(lastMessage(r.input, "user")) || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
