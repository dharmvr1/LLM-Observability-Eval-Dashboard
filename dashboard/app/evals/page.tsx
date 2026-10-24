import TimeChart from "@/components/Charts";
import { Tile, Toolbar } from "@/components/Ui";
import Link from "next/link";
import { query } from "@/lib/db";
import { DAILY_TOKEN_BUDGET } from "@/lib/config";
import { num, pct, when } from "@/lib/format";
import { RANGES, readFilters } from "@/lib/range";

export const dynamic = "force-dynamic";

const METRICS = [
  { key: "faithfulness", name: "faithfulness", color: "#2f6fed" },
  { key: "answer_relevancy", name: "answer relevancy", color: "#1a7f4b" },
  { key: "toxicity", name: "toxicity (1 = clean)", color: "#c0392b" },
];

export default async function Evals({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = readFilters(await searchParams);
  const range = RANGES[filters.range];
  const cond = `created_at > now() - INTERVAL ${range.interval}`;

  const [trend, summary, failures, usage] = await Promise.all([
    query<{ t: number; metric: string; score: number }>(`
      SELECT toUnixTimestamp(toStartOfInterval(created_at, INTERVAL ${range.bucketMinutes} MINUTE)) * 1000 AS t, metric, avg(score) AS score
      FROM evals WHERE ${cond} AND metric != 'refusal' GROUP BY t, metric ORDER BY t`),
    query<{ metric: string; n: number; mean: number; failed: number }>(`
      SELECT metric, count() AS n, avg(score) AS mean, countIf(passed = 0) AS failed
      FROM evals WHERE ${cond} GROUP BY metric ORDER BY metric`),
    query<{ at: string; trace_id: string; metric: string; score: number; reason: string; user_id: string }>(`
      SELECT toString(created_at) AS at, trace_id, metric, score, reason, user_id
      FROM evals WHERE ${cond} AND passed = 0 ORDER BY created_at DESC LIMIT 20`),
    query<{ model: string; job: string; tokens: number; calls: number }>(`
      SELECT model, job, sum(total_tokens) AS tokens, count() AS calls
      FROM judge_usage WHERE created_at > now() - INTERVAL 24 HOUR GROUP BY model, job ORDER BY tokens DESC`),
  ]);

  // one chart row per time bucket, one column per metric
  const rows = new Map<number, { t: number } & Record<string, number | null>>();
  for (const p of trend) {
    const row = rows.get(p.t) ?? { t: p.t };
    row[p.metric] = p.score;
    rows.set(p.t, row);
  }
  const chartData = [...rows.values()].sort((a, b) => a.t - b.t);
  const get = (metric: string) => summary.find((s) => s.metric === metric);
  const scored = Math.max(...summary.map((s) => s.n), 0);
  const refusals = get("refusal")?.n ?? 0;

  // tokens per model over the last 24 hours, against the daily budget
  const perModel = new Map<string, number>();
  for (const u of usage) perModel.set(u.model, (perModel.get(u.model) ?? 0) + u.tokens);

  return (
    <>
      <h1>Evals</h1>
      <p className="sub">Quality scores from the eval job (DeepEval), {range.label}. Scores are 0 to 1, higher is better for every metric.</p>
      <Toolbar path="/evals" filters={filters} showDemo={false} />

      <div className="tiles">
        <Tile label="Scored responses" value={num(scored)} note="largest metric count" />
        {["faithfulness", "answer_relevancy", "toxicity"].map((m) => {
          const s = get(m);
          return <Tile key={m} label={`${m.replace("_", " ")} (mean)`} value={s ? s.mean.toFixed(2) : "-"}
            note={s ? `${num(s.failed)} of ${num(s.n)} failed` : "no scores in range"} tone={s && s.failed / s.n > 0.2 ? "bad" : undefined} />;
        })}
        <Tile label="Refusals" value={num(refusals)} note="bot declined to answer" />
      </div>

      <div className="card">
        <h2>Mean score over time</h2>
        <TimeChart data={chartData} series={METRICS} bucketMinutes={range.bucketMinutes} />
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Judge token budget, last 24 hours</h2>
          <p className="sub" style={{ marginBottom: 6 }}>Daily limit used by the jobs: {num(DAILY_TOKEN_BUDGET)} tokens per model.</p>
          {perModel.size === 0 ? <div className="empty">No judge calls logged.</div> : [...perModel.entries()].map(([model, tokens]) => (
            <div key={model} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{model}</span><span className="mono">{num(tokens)} / {num(DAILY_TOKEN_BUDGET)} ({pct(tokens / DAILY_TOKEN_BUDGET)})</span>
              </div>
              <div className={`meter ${tokens / DAILY_TOKEN_BUDGET > 0.8 ? "bad" : ""}`}><div style={{ width: `${Math.min(100, (tokens / DAILY_TOKEN_BUDGET) * 100)}%` }} /></div>
            </div>
          ))}
          {usage.length > 0 ? (
            <table>
              <thead><tr><th>Job</th><th>Model</th><th className="num">Calls</th><th className="num">Tokens</th></tr></thead>
              <tbody>{usage.map((u, i) => <tr key={i}><td>{u.job}</td><td>{u.model}</td><td className="num">{num(u.calls)}</td><td className="num">{num(u.tokens)}</td></tr>)}</tbody>
            </table>
          ) : null}
        </div>

        <div className="card">
          <h2>Per metric</h2>
          {summary.length === 0 ? <div className="empty">No scores in this range.</div> : (
            <table>
              <thead><tr><th>Metric</th><th className="num">Scored</th><th className="num">Mean</th><th className="num">Failed</th></tr></thead>
              <tbody>{summary.map((s) => (
                <tr key={s.metric}><td>{s.metric}</td><td className="num">{num(s.n)}</td><td className="num">{s.mean.toFixed(2)}</td><td className="num">{num(s.failed)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Latest failed scores</h2>
        {failures.length === 0 ? <div className="empty">No failed scores in this range.</div> : (
          <table>
            <thead><tr><th>Scored at</th><th>Metric</th><th className="num">Score</th><th>User</th><th>Reason</th></tr></thead>
            <tbody>{failures.map((f, i) => (
              <tr key={i}>
                <td className="mono" style={{ whiteSpace: "nowrap" }}><Link href={`/traces/${f.trace_id}`}>{when(f.at)}</Link></td>
                <td>{f.metric}</td><td className="num">{f.score.toFixed(2)}</td><td>{f.user_id || "-"}</td><td>{f.reason}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
