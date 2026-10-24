import Link from "next/link";
import { Tile } from "@/components/Ui";
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
type ProbeRun = {
  at: string; pct: number; first_leak: number; stored: number; triage: number; prom: number; firing: number;
  received: number; slack: number; deploy_to_slack: number; passed: number;
};
type SentAlert = { at: string; status: string; severity: string; alertname: string; app_id: string; summary: string };

function Actions({ t }: { t: Triage }) {
  const button = (status: string, label: string) => (
    <form action={setTriageStatus} className="inline">
      <input type="hidden" name="trace" value={t.trace_id} />
      <input type="hidden" name="span" value={t.span_id} />
      <input type="hidden" name="status" value={status} />
      <button type="submit">{label}</button>
    </form>
  );
  return <div style={{ display: "flex", gap: 6 }}>{button("confirmed", "Confirm leak")}{button("false_positive", "False alarm")}</div>;
}

export default async function Alerts() {
  const [triage, resolved, drift, evals, sent, probes] = await Promise.all([
    query<Triage>(`
      SELECT toString(created_at) AS created, trace_id, span_id, app_id, user_id, risk, types, reason, preview_masked AS preview, status
      FROM pii_triage WHERE status IN ('open', 'review')
      ORDER BY status = 'open' DESC, created_at DESC LIMIT 100`),
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
      SELECT toString(received_at) AS at, status, severity, alertname, app_id, summary
      FROM alert_events ORDER BY received_at DESC LIMIT 15`),
    query<ProbeRun>(`
      SELECT toString(started_at) AS at, sample_pct AS pct, seconds_to_first_leak AS first_leak, stored_after_leak AS stored,
             triage_after_leak AS triage, metric_after_leak AS prom, firing_after_leak AS firing,
             received_after_leak AS received, slack_after_leak AS slack, deploy_to_slack, passed
      FROM probe_runs ORDER BY started_at DESC LIMIT 10`),
  ]);

  const open = triage.filter((t) => t.status === "open");
  const review = triage.filter((t) => t.status === "review");
  const badEvals = evals.filter((e) => e.n > 0 && e.failed / e.n > 0.2);

  return (
    <>
      <h1>Alerts</h1>
      <p className="sub">Everything that needs a person to look. These are read from the tables; they are sent to Slack by Alertmanager (see the history below).</p>

      <div className="tiles">
        <Tile label="PII leaks, high priority" value={num(open.length)} note="status open" tone={open.length > 0 ? "bad" : "good"} />
        <Tile label="PII to review" value={num(review.length)} note="regex match the guard did not confirm" />
        <Tile label="Apps drifting" value={num(drift.length)} note="latest PSI above 0.2" tone={drift.length > 0 ? "bad" : "good"} />
        <Tile label="Metrics failing" value={num(badEvals.length)} note="more than 20% failed, last 24 hours" tone={badEvals.length > 0 ? "bad" : "good"} />
      </div>

      <div className="card">
        <h2>PII triage queue</h2>
        {triage.length === 0 ? <div className="empty">Nothing to review.</div> : (
          <table>
            <thead><tr><th>Found</th><th>Status</th><th>App / user</th><th className="num">Risk</th><th>Why</th><th>Preview (digits masked)</th><th>Decision</th></tr></thead>
            <tbody>{triage.map((t) => (
              <tr key={`${t.trace_id}-${t.span_id}`}>
                <td className="mono" style={{ whiteSpace: "nowrap" }}><Link href={`/traces/${t.trace_id}`}>{when(t.created)}</Link></td>
                <td><span className={`badge ${t.status === "open" ? "bad" : "warn"}`}>{t.status}</span></td>
                <td>{t.app_id}<br /><span style={{ color: "var(--muted)" }}>{t.user_id || "-"}</span></td>
                <td className="num">{t.risk.toFixed(2)}</td>
                <td>{t.types.join(", ")}<br /><span style={{ color: "var(--muted)" }}>{t.reason}</span></td>
                <td className="clip" title={t.preview}>{t.preview}</td>
                <td><Actions t={t} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {resolved.length > 0 ? (
          <details style={{ marginTop: 12 }}>
            <summary>Recently resolved ({resolved.length})</summary>
            <table>
              <tbody>{resolved.map((t) => (
                <tr key={`${t.trace_id}-${t.span_id}`}>
                  <td className="mono"><Link href={`/traces/${t.trace_id}`}>{when(t.created)}</Link></td>
                  <td><span className={`badge ${t.status === "confirmed" ? "bad" : "muted"}`}>{t.status.replace("_", " ")}</span></td>
                  <td>{t.app_id}</td><td className="clip">{t.preview}</td>
                </tr>
              ))}</tbody>
            </table>
          </details>
        ) : null}
      </div>

      <div className="card">
        <h2>Drift</h2>
        {drift.length === 0 ? <div className="empty">No app is drifting.</div> : (
          <table>
            <thead><tr><th>App</th><th className="num">PSI</th><th className="num">Baseline / current prompts</th><th>Checked</th><th>Least typical current prompts</th></tr></thead>
            <tbody>{drift.map((d) => (
              <tr key={d.app_id}>
                <td><Link href="/drift">{d.app_id}</Link></td>
                <td className="num">{d.psi.toFixed(3)}</td>
                <td className="num">{num(d.baseline)} / {num(d.current)}</td>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>{when(d.at)}</td>
                <td>{d.note.replace("least typical current prompts: ", "")}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Regression probe: how fast is a leak caught?</h2>
        <p className="sub" style={{ marginBottom: 6 }}>
          <code>make probe</code> deploys a fake bug (1% of a stub bot's answers contain a fake SSN) and times each step, in seconds after
          the first leaking answer. Target: bug deployed to Slack in under 300 s.
        </p>
        {probes.length === 0 ? <div className="empty">No probe has run yet.</div> : (
          <table>
            <thead>
              <tr><th>Bug deployed</th><th className="num">Sampling</th><th className="num">First leak</th><th className="num">Stored</th><th className="num">Triage</th>
                <th className="num">Prometheus</th><th className="num">Firing</th><th className="num">Receiver</th><th className="num">Slack</th>
                <th className="num">Deploy to Slack</th><th>Result</th></tr>
            </thead>
            <tbody>{probes.map((p, i) => {
              const sec = (v: number) => (v >= 0 ? `+${v.toFixed(0)} s` : "never");
              return (
                <tr key={i}>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{when(p.at)}</td>
                  <td className="num">{p.pct}%</td><td className="num">{sec(p.first_leak)}</td>
                  <td className="num">{sec(p.stored)}</td><td className="num">{sec(p.triage)}</td><td className="num">{sec(p.prom)}</td>
                  <td className="num">{sec(p.firing)}</td><td className="num">{sec(p.received)}</td><td className="num">{sec(p.slack)}</td>
                  <td className="num">{p.deploy_to_slack >= 0 ? `${p.deploy_to_slack.toFixed(0)} s` : "-"}</td>
                  <td><span className={`badge ${p.passed ? "good" : "bad"}`}>{p.passed ? "under 300 s" : "too slow"}</span></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Alert history (what was sent)</h2>
        <p className="sub" style={{ marginBottom: 6 }}>
          Every alert Alertmanager delivered to the local receiver (<code>make receiver</code>), newest first.
          Prometheus rules live in <code>prometheus/alerts.yml</code>.
        </p>
        {sent.length === 0 ? <div className="empty">No alerts have been sent yet.</div> : (
          <table>
            <thead><tr><th>Received</th><th>State</th><th>Severity</th><th>Alert</th><th>App</th><th>Summary</th></tr></thead>
            <tbody>{sent.map((a, i) => (
              <tr key={i}>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>{when(a.at)}</td>
                <td><span className={`badge ${a.status === "firing" ? "bad" : "good"}`}>{a.status}</span></td>
                <td><span className={`badge ${a.severity === "critical" ? "bad" : "warn"}`}>{a.severity || "-"}</span></td>
                <td>{a.alertname}</td><td>{a.app_id || "-"}</td><td>{a.summary}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Eval health, last 24 hours</h2>
        {evals.length === 0 ? <div className="empty">No scores in the last 24 hours.</div> : (
          <table>
            <thead><tr><th>Metric</th><th className="num">Scored</th><th className="num">Failed</th><th className="num">Mean</th><th>Status</th></tr></thead>
            <tbody>{evals.map((e) => (
              <tr key={e.metric}>
                <td>{e.metric}</td><td className="num">{num(e.n)}</td><td className="num">{num(e.failed)}</td><td className="num">{e.mean.toFixed(2)}</td>
                <td>{e.failed / e.n > 0.2 ? <span className="badge bad">failing</span> : <span className="badge good">ok</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
