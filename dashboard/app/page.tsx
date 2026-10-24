import ChartCard from "@/components/ChartCard";
import TimeChart from "@/components/Charts";
import Sparkline from "@/components/Sparkline";
import { Banner, BarList, Delta, HealthItem, PageHead, Tile, Toolbar, type Tone } from "@/components/Ui";
import { query } from "@/lib/db";
import { ms, num, pct, rate, usd } from "@/lib/format";
import { costUsd } from "@/lib/pricing";
import { RANGES, previousCondition, readFilters, spanCondition } from "@/lib/range";

export const dynamic = "force-dynamic";

type Stats = { spans: number; errors: number; p95: number | null; tokens: number; users: number };
type Point = { t: number; spans: number; p95: number | null; errors: number; tokens: number };
type UserModel = { user_id: string; model: string; app_id: string; calls: number; tin: number; tout: number };

const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = readFilters(await searchParams);
  const range = RANGES[filters.range];
  // Only LLM calls (spans with a model name); framework wrapper spans would inflate the counts.
  const now = `${spanCondition(filters)} AND gen_ai_request_model != ''`;
  const before = `${previousCondition(filters)} AND gen_ai_request_model != ''`;
  const statsSql = (where: string) => `
    SELECT count() AS spans, countIf(status = 'Error') AS errors, quantile(0.95)(latency_ms) AS p95,
           sum(input_tokens + output_tokens) AS tokens, uniqExactIf(user_id, user_id != '') AS users
    FROM spans WHERE ${where}`;

  const [stats, prevStats, series, byUser, pii, drift, evals, probes] = await Promise.all([
    query<Stats>(statsSql(now)),
    query<Stats>(statsSql(before)),
    query<Point>(`
      SELECT toUnixTimestamp(toStartOfInterval(start_time, INTERVAL ${range.bucketMinutes} MINUTE)) * 1000 AS t,
             count() AS spans, quantile(0.95)(latency_ms) AS p95, countIf(status = 'Error') AS errors, sum(input_tokens + output_tokens) AS tokens
      FROM spans WHERE ${now} GROUP BY t ORDER BY t`),
    query<UserModel>(`
      SELECT user_id, gen_ai_request_model AS model, app_id, count() AS calls, sum(input_tokens) AS tin, sum(output_tokens) AS tout
      FROM spans WHERE ${now} GROUP BY user_id, model, app_id`),
    query<{ open: number; review: number }>(`SELECT countIf(status = 'open') AS open, countIf(status = 'review') AS review FROM pii_triage`),
    query<{ drifting: number; measured: number }>(`
      SELECT countIf(alert = 1) AS drifting, count() AS measured FROM (
        SELECT app_id, argMax(psi, created_at) AS psi, argMax(alert, created_at) AS alert FROM drift
        WHERE app_id NOT LIKE 'drift-demo-%' AND app_id != 'ALL' GROUP BY app_id HAVING psi >= 0)`),
    query<{ failing: number; scored: number }>(`
      SELECT countIf(n >= 5 AND failed / n > 0.2) AS failing, sum(n) AS scored FROM (
        SELECT metric, count() AS n, countIf(passed = 0) AS failed FROM evals
        WHERE created_at > now() - INTERVAL 24 HOUR AND metric != 'refusal' GROUP BY metric)`),
    query<{ trials: number; ok_trials: number; median_s: number | null }>(`
      SELECT count() AS trials, countIf(passed = 1) AS ok_trials, medianIf(deploy_to_slack, passed = 1) AS median_s FROM probe_runs`),
  ]);
  const s = stats[0];
  const p = prevStats[0];
  const vs = " vs previous period";

  // cost per user and calls per app, from the same grouped rows
  const users = new Map<string, number>();
  const apps = new Map<string, number>();
  const models = new Set<string>();
  let totalCost = 0;
  for (const row of byUser) {
    const cost = costUsd(row.model, row.tin, row.tout);
    totalCost += cost;
    users.set(row.user_id || "(no user id)", (users.get(row.user_id || "(no user id)") ?? 0) + cost);
    apps.set(row.app_id, (apps.get(row.app_id) ?? 0) + row.calls);
    models.add(row.model);
  }
  const topUsers = [...users.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topApps = [...apps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const errorRate = s.spans > 0 ? s.errors / s.spans : 0;
  const prevErrorRate = p.spans > 0 ? p.errors / p.spans : null;
  const p95Points = series.filter((x) => x.p95 !== null).map((x) => x.p95 as number);

  // health: four plain-language lines and one banner
  const piiTone: Tone = pii[0].open > 0 ? "bad" : pii[0].review > 0 ? "warn" : "good";
  const driftTone: Tone = drift[0].drifting > 0 ? "warn" : drift[0].measured > 0 ? "good" : "none";
  const evalTone: Tone = evals[0].failing > 0 ? "warn" : evals[0].scored > 0 ? "good" : "none";
  const probe = probes[0];
  const issues = [
    pii[0].open > 0 ? `${pii[0].open} open PII leak${pii[0].open > 1 ? "s" : ""}` : "",
    drift[0].drifting > 0 ? `${drift[0].drifting} app${drift[0].drifting > 1 ? "s" : ""} drifting` : "",
    evals[0].failing > 0 ? `${evals[0].failing} quality metric${evals[0].failing > 1 ? "s" : ""} failing` : "",
  ].filter(Boolean);

  return (
    <>
      <PageHead title="Overview" subtitle={`How your LLM applications are doing, ${range.label}.`}>
        <Toolbar path="/" filters={filters} />
      </PageHead>

      <Banner tone={piiTone === "bad" ? "critical" : issues.length > 0 || piiTone === "warn" ? "attention" : "ok"}>
        {issues.length > 0 ? <><strong>Needs attention:</strong> {issues.join(" · ")}.</> : piiTone === "warn" ? <><strong>{pii[0].review} item(s) to review</strong> in the PII queue.</> : <><strong>All clear.</strong> No open PII leaks, no drift, answer quality within limits.</>}
      </Banner>
      <div className="health">
        <HealthItem tone={piiTone} href="/alerts" title="Privacy"
          detail={pii[0].open > 0 ? `${pii[0].open} open leak${pii[0].open > 1 ? "s" : ""}, ${pii[0].review} to review` : pii[0].review > 0 ? `${pii[0].review} to review` : "No open leaks"} />
        <HealthItem tone={driftTone} href="/drift" title="Prompt drift"
          detail={drift[0].measured === 0 ? "Not enough data yet" : drift[0].drifting > 0 ? `${drift[0].drifting} of ${drift[0].measured} apps drifting` : `${drift[0].measured} apps stable`} />
        <HealthItem tone={evalTone} href="/evals" title="Answer quality"
          detail={evals[0].scored === 0 ? "No scores in 24 hours" : evals[0].failing > 0 ? `${evals[0].failing} metric${evals[0].failing > 1 ? "s" : ""} failing` : "All metrics within limits"} />
        <HealthItem tone={probe.ok_trials > 0 ? "good" : "none"} href="/reliability" title="Alert pipeline"
          detail={probe.ok_trials > 0 ? `A leak reaches Slack in about ${Math.round(probe.median_s ?? 0)} s (median of ${probe.ok_trials} tests)` : "No probe has run"} />
      </div>

      <section className="card hero" aria-label="Headline">
        <div>
          <div className="label">LLM calls</div>
          <div className="figure">{num(s.spans)}</div>
          <Delta current={s.spans} previous={p.spans} vs={vs} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{rate(s.spans, range.seconds)} on average</div>
        </div>
        <div>
          <div className="facts">
            <div><div className="fact-v">{num(s.spans - s.errors)}</div><div className="fact-l">Successful</div></div>
            <div><div className="fact-v">{num(s.errors)}</div><div className="fact-l">Failed</div></div>
            <div><div className="fact-v">{num(apps.size)}</div><div className="fact-l">Apps</div></div>
            <div><div className="fact-v">{num(models.size)}</div><div className="fact-l">Models</div></div>
          </div>
          {series.length >= 4 ? <div style={{ marginTop: 14, overflow: "hidden" }}><Sparkline values={series.map((x) => x.spans)} width={520} height={64} /></div> : null}
        </div>
      </section>

      <div className="tiles">
        <Tile label="p95 latency" value={ms(s.p95)} note="95% of calls were faster" delta={<Delta current={s.p95 ?? 0} previous={p.p95} upIsGood={false} vs={vs} />} spark={p95Points} />
        <Tile label="Error rate" value={pct(errorRate)} note={`${num(s.errors)} failed calls`} delta={<Delta current={errorRate} previous={prevErrorRate} upIsGood={false} vs={vs} />}
          spark={series.map((x) => (x.spans > 0 ? x.errors / x.spans : 0))} />
        <Tile label="Tokens" value={num(s.tokens)} note="input plus output" delta={<Delta current={s.tokens} previous={p.tokens} vs={vs} />} spark={series.map((x) => x.tokens)} />
        <Tile label="Estimated cost" value={usd(totalCost)} note="placeholder prices (lib/pricing.ts)" />
        <Tile label="Active users" value={num(s.users)} note="distinct user ids" delta={<Delta current={s.users} previous={p.users} vs={vs} />} />
      </div>

      <div className="grid2">
        <ChartCard title="Calls over time" subtitle="Successful and failed LLM calls" columns={["Time (UTC)", "Successful", "Failed"]}
          rows={series.map((x) => [iso(x.t), x.spans - x.errors, x.errors])} empty={series.length === 0}>
          <TimeChart kind="bar" stacked bucketMinutes={range.bucketMinutes} ariaLabel="Successful and failed LLM calls over time"
            data={series.map((x) => ({ t: x.t, ok: x.spans - x.errors, failed: x.errors }))}
            series={[{ key: "ok", name: "Successful", color: "var(--s1)" }, { key: "failed", name: "Failed", color: "var(--critical)" }]} />
        </ChartCard>
        <ChartCard title="p95 latency" subtitle="95% of calls finished faster than this" columns={["Time (UTC)", "p95 latency"]}
          rows={series.map((x) => [iso(x.t), x.p95 === null ? null : ms(x.p95)])} empty={series.length === 0}>
          <TimeChart kind="area" format="ms" bucketMinutes={range.bucketMinutes} ariaLabel="p95 latency over time"
            data={series.map((x) => ({ t: x.t, p95: x.p95 }))} series={[{ key: "p95", name: "p95 latency", color: "var(--s1)" }]} />
        </ChartCard>
      </div>

      <div className="grid2">
        <section className="card">
          <div className="card-head"><div><h2>Estimated cost per user</h2><p className="sub">Top users, at placeholder prices</p></div></div>
          <BarList rows={topUsers.map(([name, cost]) => ({ name, value: cost, display: usd(cost) }))} />
        </section>
        <section className="card">
          <div className="card-head"><div><h2>Calls per app</h2><p className="sub">Where the traffic comes from</p></div></div>
          <BarList rows={topApps.map(([name, calls]) => ({ name, value: calls, display: num(calls) }))} />
        </section>
      </div>
    </>
  );
}
