import ChartCard from "@/components/ChartCard";
import { StageBars } from "@/components/Charts";
import { Badge, BarList, Empty, PageHead, Tile } from "@/components/Ui";
import { query } from "@/lib/db";
import { num, when } from "@/lib/format";

export const dynamic = "force-dynamic";

type Probe = {
  at: string; pct: number; first_leak: number; stored: number; triage: number; prom: number; firing: number; received: number;
  slack: number; deploy_to_slack: number; passed: number;
};
type Scale = {
  at: string; pct: number; rate: number; achieved: number; p99: number; accepted: number; stored: number; drain: number;
  backlog: number; slope: number; cpu: number; ch_cpu: number; passed: number; note: string;
};

const STAGES = ["Collector to ClickHouse", "Waiting for the PII job", "Exporter and scrape", "Rule evaluation", "Alertmanager and Slack"];
const TARGET_SECONDS = 300;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export default async function Reliability() {
  const [probes, scales] = await Promise.all([
    query<Probe>(`
      SELECT toString(started_at) AS at, sample_pct AS pct, seconds_to_first_leak AS first_leak, stored_after_leak AS stored, triage_after_leak AS triage,
             metric_after_leak AS prom, firing_after_leak AS firing, received_after_leak AS received, slack_after_leak AS slack, deploy_to_slack, passed
      FROM probe_runs ORDER BY started_at DESC LIMIT 12`),
    query<Scale>(`
      SELECT toString(started_at) AS at, sample_pct AS pct, target_rate AS rate, achieved_rate AS achieved, request_p99_ms AS p99, accepted, stored,
             drain_seconds AS drain, backlog_median AS backlog, backlog_slope AS slope, collector_cpu_cores AS cpu, clickhouse_cpu_max_pct AS ch_cpu, passed, note
      FROM scale_runs ORDER BY started_at DESC LIMIT 12`),
  ]);

  const valid = probes.filter((p) => p.slack >= 0 && p.firing >= 0 && p.prom >= 0 && p.triage >= 0 && p.stored >= 0);
  const stageRows = valid.map((p) => ({
    label: when(p.at).slice(5, 16).replace("-", "/"),
    note: `${p.pct}% sampling · first leak +${p.first_leak.toFixed(0)} s`,
    stages: [p.stored, p.triage - p.stored, p.prom - p.triage, p.firing - p.prom, p.slack - p.firing],
    total: p.slack, ok: p.passed === 1,
  }));
  const deployToSlack = probes.filter((p) => p.deploy_to_slack > 0).map((p) => p.deploy_to_slack);
  const leakToSlack = valid.map((p) => p.slack);
  const passedProbes = probes.filter((p) => p.passed === 1).length;

  const okScales = scales.filter((s) => s.passed === 1);
  const maxRate = Math.max(...okScales.map((s) => s.rate), 0);
  const lost = scales.filter((s) => s.pct === 100).reduce((sum, s) => sum + Math.max(0, s.accepted - s.stored), 0);
  const at1000 = scales.find((s) => s.rate === 1000 && s.pct === 100 && s.note.startsWith("with answer"));

  return (
    <>
      <PageHead title="Reliability" subtitle="Two questions: how fast is a problem caught, and how much traffic can the pipeline take? Both are measured by tests you can re-run (make probe, make scale-test)." />

      <h2 style={{ margin: "4px 0 12px" }}>Time to catch a leak</h2>
      <div className="tiles">
        <Tile label="Bug deployed to Slack (median)" value={median(deployToSlack) === null ? "-" : `${Math.round(median(deployToSlack)!)} s`} note={`target ${TARGET_SECONDS} s · worst ${deployToSlack.length ? Math.round(Math.max(...deployToSlack)) : "-"} s`} />
        <Tile label="Leaking answer to Slack (median)" value={median(leakToSlack) === null ? "-" : `${Math.round(median(leakToSlack)!)} s`} note="the pipeline's own delay" />
        <Tile label="Trials within target" value={`${passedProbes} of ${probes.length}`} note="each trial deploys a fake bug" />
      </div>

      <ChartCard title="Where the time goes" subtitle="Seconds from the leaking answer to the Slack notification, split into five stages (newest first)"
        columns={["Bug deployed (UTC)", "Sampling", "First leak after deploy (s)", ...STAGES.map((s) => `${s} (s)`), "Leak to Slack (s)", "Deploy to Slack (s)"]}
        rows={valid.map((p) => [when(p.at).slice(0, 16), `${p.pct}%`, p.first_leak.toFixed(0), (p.stored).toFixed(1), (p.triage - p.stored).toFixed(1), (p.prom - p.triage).toFixed(1), (p.firing - p.prom).toFixed(1), (p.slack - p.firing).toFixed(1), p.slack.toFixed(1), p.deploy_to_slack.toFixed(0)])}
        empty={stageRows.length === 0}>
        {stageRows.length === 0 ? <Empty title="No probe has run yet" hint="Run make probe." /> : <StageBars rows={stageRows} stageNames={STAGES} />}
      </ChartCard>

      <section className="card">
        <div className="card-head"><div><h2>About the leak test</h2></div></div>
        <div className="sub" style={{ maxWidth: "none", fontSize: 13.5 }}>
          A stub chatbot sends 2 requests per second. After a clean start, 1% of its answers contain a random fake SSN. The test then times every stage until
          Alertmanager reports its Slack notification. The largest and most variable stage is waiting for the PII job, which runs once a minute.
          One trial ran with the collector keeping only 10% of normal traces (the README default), and the leak was still caught, because SSN-like answers are always kept.
          <br />Limits: five or so trials, a stub bot (not a real model), the PII guard LLM switched off during the test, and Slack arrival is read from Alertmanager&apos;s counter, not from the channel.
        </div>
      </section>

      <h2 style={{ margin: "24px 0 12px" }}>How much traffic it can take</h2>
      <div className="tiles">
        <Tile label="Highest rate sustained" value={maxRate ? `${num(maxRate)} /s` : "-"} note="spans per second, no backlog (README target: 1,000)" />
        <Tile label="Spans lost" value={num(lost)} note="accepted but never stored, at 100% sampling" />
        <Tile label="Collector at 1,000 spans/s" value={at1000 ? `${at1000.cpu.toFixed(2)} cores` : "-"} note={at1000 ? `ClickHouse peak ${Math.round(at1000.ch_cpu)}% of one core` : "no run yet"} />
        <Tile label="Pipeline delay" value={at1000 ? `${(at1000.backlog / at1000.rate).toFixed(1)} s` : "-"} note="constant, not a growing queue" />
      </div>

      <div className="grid2">
        <section className="card">
          <div className="card-head"><div><h2>Sustained throughput</h2><p className="sub">Spans per second the collector accepted and stored, one bar per test (sampling share in the label)</p></div></div>
          <BarList rows={okScales.slice().reverse().map((s) => ({
            name: `${num(s.rate)}/s at ${s.pct}%${s.note.startsWith("no answer") ? " (no answers)" : ""}`,
            value: s.achieved, display: `${num(s.achieved)}`,
          }))} />
        </section>
        <section className="card">
          <div className="card-head"><div><h2>About the scale test</h2></div></div>
          <div className="sub" style={{ maxWidth: "none", fontSize: 13.5 }}>
            Fake spans (no LLM) are sent in batches of 100 at a steady pace for 30 to 120 seconds. The test checks six things: the rate was sustained, nothing was refused,
            every span was stored within a minute of the end, the backlog stayed flat, the exporter queue never filled, and the S3 archive received everything.
            <br />Limits: runs of two minutes or less, one machine, and above about 6,000 spans/s my single-process load generator becomes the bottleneck, so the true ceiling is not known.
            Collecting spans scales much further than analysing them: the PII job and the eval job are the slow parts.
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><div><h2>All scale tests</h2><p className="sub">Newest first</p></div></div>
        {scales.length === 0 ? <Empty title="No scale test has run yet" hint="Run make scale-test." /> : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Started (UTC)</th><th className="num">Target /s</th><th className="num">Achieved /s</th><th className="num">Sampling</th><th className="num">Request p99</th><th className="num">Accepted</th><th className="num">Stored</th>
                <th className="num">Drain</th><th className="num">Backlog</th><th className="num">Collector CPU</th><th>Result</th><th>Notes</th></tr></thead>
              <tbody>{scales.map((s, i) => (
                <tr key={i}>
                  <td className="mono nowrap">{when(s.at)}</td><td className="num">{num(s.rate)}</td><td className="num">{num(s.achieved)}</td><td className="num">{s.pct}%</td>
                  <td className="num">{s.p99.toFixed(0)} ms</td><td className="num">{num(s.accepted)}</td><td className="num">{num(s.stored)}</td>
                  <td className="num">{s.drain >= 0 ? `${s.drain.toFixed(0)} s` : "-"}</td><td className="num">{num(s.backlog)} spans</td><td className="num">{s.cpu.toFixed(2)} cores</td>
                  <td>{s.passed ? <Badge tone="good">passed</Badge> : <Badge tone="bad">failed</Badge>}</td><td className="muted nowrap">{s.note.startsWith("no answer") ? "no answer text" : s.note.startsWith("with answer") ? "with answer text" : s.note}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
