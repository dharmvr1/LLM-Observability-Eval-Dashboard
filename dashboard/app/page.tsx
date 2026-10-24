import TimeChart from "@/components/Charts";
import { Tile, Toolbar } from "@/components/Ui";
import { query } from "@/lib/db";
import { ms, num, pct, rate, usd } from "@/lib/format";
import { costUsd } from "@/lib/pricing";
import { RANGES, readFilters, spanCondition } from "@/lib/range";

export const dynamic = "force-dynamic";

type Stats = { spans: number; errors: number; p95: number | null; tin: number; tout: number; users: number };
type Point = { t: number; spans: number; p95: number | null; errors: number };
type UserModel = { user_id: string; model: string; calls: number; tin: number; tout: number; errors: number };

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = readFilters(await searchParams);
  const range = RANGES[filters.range];
  // Only LLM calls (spans with a model name); framework wrapper spans would inflate the counts.
  const where = `${spanCondition(filters)} AND gen_ai_request_model != ''`;

  const [stats, series, byUser] = await Promise.all([
    query<Stats>(`
      SELECT count() AS spans, countIf(status = 'Error') AS errors, quantile(0.95)(latency_ms) AS p95,
             sum(input_tokens) AS tin, sum(output_tokens) AS tout, uniqExactIf(user_id, user_id != '') AS users
      FROM spans WHERE ${where}`),
    query<Point>(`
      SELECT toUnixTimestamp(toStartOfInterval(start_time, INTERVAL ${range.bucketMinutes} MINUTE)) * 1000 AS t,
             count() AS spans, quantile(0.95)(latency_ms) AS p95, countIf(status = 'Error') AS errors
      FROM spans WHERE ${where} GROUP BY t ORDER BY t`),
    query<UserModel>(`
      SELECT user_id, gen_ai_request_model AS model, count() AS calls, sum(input_tokens) AS tin,
             sum(output_tokens) AS tout, countIf(status = 'Error') AS errors
      FROM spans WHERE ${where} GROUP BY user_id, model`),
  ]);
  const s = stats[0];

  // cost per user = sum over that user's models of tokens x price
  const users = new Map<string, { calls: number; tokens: number; cost: number; errors: number }>();
  let totalCost = 0;
  for (const row of byUser) {
    const key = row.user_id || "(no user id)";
    const entry = users.get(key) ?? { calls: 0, tokens: 0, cost: 0, errors: 0 };
    const cost = costUsd(row.model, row.tin, row.tout);
    entry.calls += row.calls;
    entry.tokens += row.tin + row.tout;
    entry.cost += cost;
    entry.errors += row.errors;
    users.set(key, entry);
    totalCost += cost;
  }
  const topUsers = [...users.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].calls - a[1].calls).slice(0, 10);
  const errorRate = s.spans > 0 ? s.errors / s.spans : null;

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">LLM calls in the {range.label}.</p>
      <Toolbar path="/" filters={filters} />

      <div className="tiles">
        <Tile label="LLM calls" value={num(s.spans)} note={`${rate(s.spans, range.seconds)} on average`} />
        <Tile label="p95 latency" value={ms(s.p95)} note="95% of calls were faster" />
        <Tile label="Error rate" value={pct(errorRate)} note={`${num(s.errors)} failed calls`} tone={errorRate !== null && errorRate > 0.05 ? "bad" : undefined} />
        <Tile label="Tokens" value={num(s.tin + s.tout)} note={`${num(s.tin)} in, ${num(s.tout)} out`} />
        <Tile label="Estimated cost" value={usd(totalCost)} note="placeholder prices, see lib/pricing.ts" />
        <Tile label="Users" value={num(s.users)} note="distinct user ids" />
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Calls over time</h2>
          <TimeChart kind="bar" data={series.map((p) => ({ t: p.t, spans: p.spans, errors: p.errors }))}
            series={[{ key: "spans", name: "calls", color: "#2f6fed" }, { key: "errors", name: "errors", color: "#c0392b" }]} bucketMinutes={range.bucketMinutes} />
        </div>
        <div className="card">
          <h2>p95 latency over time</h2>
          <TimeChart data={series.map((p) => ({ t: p.t, p95: p.p95 }))} series={[{ key: "p95", name: "p95 latency", color: "#8e44ad" }]} unit=" ms" bucketMinutes={range.bucketMinutes} />
        </div>
      </div>

      <div className="card">
        <h2>Cost per user</h2>
        {topUsers.length === 0 ? (
          <div className="empty">No calls in this range.</div>
        ) : (
          <table>
            <thead>
              <tr><th>User</th><th className="num">Calls</th><th className="num">Tokens</th><th className="num">Failed</th><th className="num">Estimated cost</th></tr>
            </thead>
            <tbody>
              {topUsers.map(([user, u]) => (
                <tr key={user}>
                  <td>{user}</td>
                  <td className="num">{num(u.calls)}</td>
                  <td className="num">{num(u.tokens)}</td>
                  <td className="num">{num(u.errors)}</td>
                  <td className="num">{usd(u.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
