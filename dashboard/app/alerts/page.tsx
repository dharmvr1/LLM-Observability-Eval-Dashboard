import Link from "next/link";
import { Badge, Empty, PageHead, Tile } from "@/components/Ui";
import { query } from "@/lib/db";
import { num, when } from "@/lib/format";
import { setTriageStatus } from "./actions";

export const dynamic = "force-dynamic";

type Triage = {
  created: string; trace_id: string; span_id: string; app_id: string; user_id: string;
  risk: number; types: string[]; reason: string; preview: string; status: string;
};
type DriftRow = { app_id: string; psi: number; baseline: number; current: number; note: string; at: string };
type EvalRow = { metric: string; n: number; failed: number; mean: number };
type SentAlert = { at: string; status: string; severity: string; alertname: string; app_id: string; summary: string };

function Decision({ t }: { t: Triage }) {
  const button = (status: string, label: string, primary = false) => (
    <form action={setTriageStatus} className="inline">
      <input type="hidden" name="trace" value={t.trace_id} />
      <input type="hidden" name="span" value={t.span_id} />
      <input type="hidden" name="status" value={status} />
      <button type="submit" className={primary ? "primary" : ""}>{label}</button>
    </form>
  );
  return <div style={{ display: "flex", gap: 6 }}>{button("confirmed", "Confirm leak", true)}{button("false_positive", "False alarm")}</div>;
}

export default async function Alerts() {
  const [triage, resolved, drift, evals, sent] = await Promise.all([
    query<Triage>(`
      SELECT toString(created_at) AS created, trace_id, span_id, app_id, user_id, risk, types, reason, preview_masked AS preview, status
      FROM pii_triage WHERE status IN ('open', 'review') ORDER BY status = 'open' DESC, created_at DESC LIMIT 100`),
    query<Triage>(`
      SELECT toString(created_at) AS created, trace_id, span_id, app_id, user_id, risk, types, reason, preview_masked AS preview, status
      FROM pii_triage WHERE status IN ('confirmed', 'false_positive') ORDER BY created_at DESC LIMIT 10`),
    query<DriftRow>(`
      SELECT app_id, psi, baseline, current, note, at FROM (
        SELECT app_id, argMax(psi, created_at) AS psi, argMax(alert, created_at) AS alert, argMax(baseline_count, created_at) AS baseline,
               argMax(current_count, created_at) AS current, argMax(note, created_at) AS note, toString(max(created_at)) AS at
        FROM drift GROUP BY app_id) WHERE alert = 1 ORDER BY psi DESC`),
    query<EvalRow>(`
      SELECT metric, count() AS n, countIf(passed = 0) AS failed, avg(score) AS mean
      FROM evals WHERE created_at > now() - INTERVAL 24 HOUR AND metric != 'refusal' GROUP BY metric ORDER BY metric`),
    query<SentAlert>(`
      SELECT toString(received_at) AS at, status, severity, alertname, app_id, summary FROM alert_events ORDER BY received_at DESC LIMIT 15`),
  ]);

  const open = triage.filter((t) => t.status === "open");
  const review = triage.filter((t) => t.status === "review");
  const badEvals = evals.filter((e) => e.n > 0 && e.failed / e.n > 0.2);

  return (
    <>
      <PageHead title="Alerts" subtitle="Everything that needs a person to look. Alertmanager sends these to Slack; the history of what was sent is at the bottom." />

      <div className="tiles">
        <Tile label="Open PII leaks" value={num(open.length)} note="high priority" />
        <Tile label="PII to review" value={num(review.length)} note="regex match the guard did not confirm" />
        <Tile label="Apps drifting" value={num(drift.length)} note="latest PSI above 0.2" />
        <Tile label="Metrics failing" value={num(badEvals.length)} note="over 20% failed, last 24 hours" />
      </div>

      <section className="card">
        <div className="card-head"><div><h2>PII triage queue</h2><p className="sub">Answers that may contain personal data (digits are masked in the preview). Decide each one.</p></div></div>
        {triage.length === 0 ? <Empty title="Nothing to review" hint="No answer has been flagged." /> : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Found</th><th>Status</th><th>App / user</th><th className="num">Risk</th><th>Why</th><th>Preview</th><th>Decision</th></tr></thead>
              <tbody>{triage.map((t) => (
                <tr key={`${t.trace_id}-${t.span_id}`}>
                  <td className="mono nowrap"><Link href={`/traces/${t.trace_id}`}>{when(t.created)}</Link></td>
                  <td>{t.status === "open" ? <Badge tone="bad">open</Badge> : <Badge tone="warn">review</Badge>}</td>
                  <td>{t.app_id}<div className="muted">{t.user_id || "-"}</div></td>
                  <td className="num">{t.risk.toFixed(2)}</td>
                  <td>{t.types.join(", ")}<div className="muted">{t.reason}</div></td>
                  <td className="clip" title={t.preview}>{t.preview}</td>
                  <td><Decision t={t} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {resolved.length > 0 ? (
          <details style={{ marginTop: 12 }}>
            <summary>Recently resolved ({resolved.length})</summary>
            <table>
              <tbody>{resolved.map((t) => (
                <tr key={`${t.trace_id}-${t.span_id}`}>
                  <td className="mono nowrap"><Link href={`/traces/${t.trace_id}`}>{when(t.created)}</Link></td>
                  <td>{t.status === "confirmed" ? <Badge tone="bad">confirmed leak</Badge> : <Badge tone="none">false alarm</Badge>}</td>
                  <td>{t.app_id}</td><td className="clip">{t.preview}</td>
                </tr>
              ))}</tbody>
            </table>
          </details>
        ) : null}
      </section>

      <div className="grid2">
        <section className="card">
          <div className="card-head"><div><h2>Drifting apps</h2><p className="sub">Latest PSI above 0.2</p></div><Link href="/drift">Open drift</Link></div>
          {drift.length === 0 ? <Empty title="No app is drifting" /> : (
            <table>
              <thead><tr><th>App</th><th className="num">PSI</th><th className="num">Prompts (before / now)</th></tr></thead>
              <tbody>{drift.map((d) => (
                <tr key={d.app_id}><td>{d.app_id}</td><td className="num">{d.psi.toFixed(2)}</td><td className="num">{num(d.baseline)} / {num(d.current)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
        <section className="card">
          <div className="card-head"><div><h2>Answer quality, last 24 hours</h2><p className="sub">A metric fails when over 20% of its scores fail</p></div><Link href="/evals">Open evals</Link></div>
          {evals.length === 0 ? <Empty title="No scores in 24 hours" /> : (
            <table>
              <thead><tr><th>Metric</th><th className="num">Scored</th><th className="num">Failed</th><th className="num">Mean</th><th>Status</th></tr></thead>
              <tbody>{evals.map((e) => (
                <tr key={e.metric}>
                  <td>{e.metric.replace("_", " ")}</td><td className="num">{num(e.n)}</td><td className="num">{num(e.failed)}</td><td className="num">{e.mean.toFixed(2)}</td>
                  <td>{e.failed / e.n > 0.2 ? <Badge tone="bad">failing</Badge> : <Badge tone="good">ok</Badge>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><div><h2>Alert history</h2><p className="sub">Every alert Alertmanager delivered to the local receiver, newest first. Rules live in prometheus/alerts.yml.</p></div></div>
        {sent.length === 0 ? <Empty title="No alerts have been sent yet" /> : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Received</th><th>State</th><th>Severity</th><th>Alert</th><th>App</th><th>Summary</th></tr></thead>
              <tbody>{sent.map((a, i) => (
                <tr key={i}>
                  <td className="mono nowrap">{when(a.at)}</td>
                  <td>{a.status === "firing" ? <Badge tone="bad">firing</Badge> : <Badge tone="good">resolved</Badge>}</td>
                  <td>{a.severity === "critical" ? <Badge tone="bad">critical</Badge> : <Badge tone="warn">{a.severity || "warning"}</Badge>}</td>
                  <td>{a.alertname}</td><td>{a.app_id || "-"}</td><td>{a.summary}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
