import Link from "next/link";
import ChartCard from "@/components/ChartCard";
import TimeChart from "@/components/Charts";
import { Badge, Empty, Meter, PageHead, Tile, Toolbar } from "@/components/Ui";
import { DAILY_TOKEN_BUDGET } from "@/lib/config";
import { query } from "@/lib/db";
import { num, pct, when } from "@/lib/format";
import { RANGES, readFilters } from "@/lib/range";

export const dynamic = "force-dynamic";

// The pass lines used by the eval job (app/jobs/eval_job.py): a score at or above the line passes.
const METRICS = [
  { key: "faithfulness", name: "Faithfulness", line: 0.8, color: "var(--s1)", hint: "answers stick to the given context" },
  { key: "answer_relevancy", name: "Answer relevancy", line: 0.5, color: "var(--s2)", hint: "answers address the question" },
  { key: "toxicity", name: "Toxicity (1 = clean)", line: 0.5, color: "var(--s3)", hint: "answers are free of toxic content" },
];

const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

export default async function Evals({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = readFilters(await searchParams);
  const range = RANGES[filters.range];
  const cond = `created_at > now() - INTERVAL ${range.interval}`;

  const [trend, summary, failures, usage] = await Promise.all([
    query<{ t: number; metric: string; score: number }>(`
      SELECT toUnixTimestamp(toStartOfInterval(created_at, INTERVAL ${range.bucketMinutes} MINUTE)) * 1000 AS t, metric, avg(score) AS score
      FROM evals WHERE ${cond} AND metric != 'refusal' GROUP BY t, metric ORDER BY t`),
    query<{ metric: string; n: number; mean: number; failed: number }>(`
      SELECT metric, count() AS n, avg(score) AS mean, countIf(passed = 0) AS failed FROM evals WHERE ${cond} GROUP BY metric ORDER BY metric`),
    query<{ at: string; trace_id: string; metric: string; score: number; reason: string; user_id: string }>(`
      SELECT toString(created_at) AS at, trace_id, metric, score, reason, user_id FROM evals WHERE ${cond} AND passed = 0 ORDER BY created_at DESC LIMIT 20`),
    query<{ model: string; job: string; tokens: number; calls: number }>(`
      SELECT model, job, sum(total_tokens) AS tokens, count() AS calls FROM judge_usage
      WHERE created_at > now() - INTERVAL 24 HOUR GROUP BY model, job ORDER BY tokens DESC`),
  ]);

  const rows = new Map<number, { t: number } & Record<string, number | null>>();
  for (const p of trend) {
    const row = rows.get(p.t) ?? { t: p.t };
    row[p.metric] = p.score;
    rows.set(p.t, row);
  }
  const chartData = [...rows.values()].sort((a, b) => a.t - b.t);
  const get = (key: string) => summary.find((s) => s.metric === key);
  const scored = Math.max(...summary.map((s) => s.n), 0);
  const refusals = get("refusal")?.n ?? 0;

  const perModel = new Map<string, number>();
  for (const u of usage) perModel.set(u.model, (perModel.get(u.model) ?? 0) + u.tokens);

  return (
    <>
      <PageHead title="Evals" subtitle={`Quality scores from the eval job (DeepEval), ${range.label}. Every score is 0 to 1 and higher is better.`}>
        <Toolbar path="/evals" filters={filters} showDemo={false} />
      </PageHead>

      <div className="tiles">
        {METRICS.map((m) => {
          const s = get(m.key);
          const failingShare = s ? s.failed / s.n : 0;
          return (
            <div className="tile" key={m.key}>
              <div className="label">{m.name}</div>
              <div className="value">{s ? s.mean.toFixed(2) : "-"}</div>
              {s ? (
                <>
                  <div style={{ margin: "8px 0 4px" }}><Meter value={s.mean} mark={m.line} severity={s.mean < m.line ? "bad" : undefined} /></div>
                  <div className="note">pass line {m.line} · {num(s.failed)} of {num(s.n)} failed {failingShare > 0.2 ? "· over 20%" : ""}</div>
                </>
              ) : <div className="note">no scores in this range</div>}
            </div>
          );
        })}
        <Tile label="Scored responses" value={num(scored)} note={`${num(refusals)} refusals (declined to answer)`} />
      </div>

      <ChartCard title="Mean score over time" subtitle="Each line is one metric; the red line is the faithfulness pass line (0.8)"
        columns={["Time (UTC)", ...METRICS.map((m) => m.name)]}
        rows={chartData.map((r) => [iso(r.t), ...METRICS.map((m) => (r[m.key] === null || r[m.key] === undefined ? null : (r[m.key] as number).toFixed(2)))])}
        empty={chartData.length === 0}>
        <TimeChart kind="line" format="score" yDomain={[0, 1]} threshold={{ value: 0.8, label: "0.8" }} bucketMinutes={range.bucketMinutes}
          ariaLabel="Mean evaluation score per metric over time"
          data={chartData} series={METRICS.map((m) => ({ key: m.key, name: m.name, color: m.color }))} />
      </ChartCard>

      <div className="grid2">
        <section className="card">
          <div className="card-head"><div><h2>Judge token budget</h2><p className="sub">Last 24 hours against the daily limit of {num(DAILY_TOKEN_BUDGET)} tokens per model</p></div></div>
          {perModel.size === 0 ? <Empty title="No judge calls logged" /> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[...perModel.entries()].map(([model, tokens]) => {
                const share = tokens / DAILY_TOKEN_BUDGET;
                return (
                  <div key={model}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span>{model}</span>
                      <span className="num muted">{num(tokens)} / {num(DAILY_TOKEN_BUDGET)} <b style={{ color: "var(--ink)" }}>{pct(share)}</b></span>
                    </div>
                    <Meter value={tokens} max={DAILY_TOKEN_BUDGET} severity={share > 0.8 ? "bad" : share > 0.5 ? "warn" : undefined} />
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <section className="card">
          <div className="card-head"><div><h2>By metric</h2><p className="sub">Scores written in this range</p></div></div>
          {summary.length === 0 ? <Empty title="No scores in this range" hint="Run the eval job with make eval." /> : (
            <table>
              <thead><tr><th>Metric</th><th className="num">Scored</th><th className="num">Mean</th><th className="num">Failed</th></tr></thead>
              <tbody>{summary.map((s) => (
                <tr key={s.metric}><td>{s.metric.replace("_", " ")}</td><td className="num">{num(s.n)}</td><td className="num">{s.mean.toFixed(2)}</td><td className="num">{num(s.failed)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><div><h2>Latest failed scores</h2><p className="sub">Click the time to open the trace</p></div></div>
        {failures.length === 0 ? <Empty title="No failed scores" hint="Every score in this range passed its line." /> : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Scored at</th><th>Metric</th><th className="num">Score</th><th>User</th><th>Reason</th></tr></thead>
              <tbody>{failures.map((f, i) => (
                <tr key={i}>
                  <td className="mono nowrap"><Link href={`/traces/${f.trace_id}`}>{when(f.at)}</Link></td>
                  <td>{f.metric.replace("_", " ")}</td>
                  <td className="num"><Badge tone="bad">{f.score.toFixed(2)}</Badge></td>
                  <td>{f.user_id || "-"}</td><td>{f.reason}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
