import ChartCard from "@/components/ChartCard";
import TimeChart from "@/components/Charts";
import { Badge, BarList, Empty, PageHead, Tile, Toolbar } from "@/components/Ui";
import { query } from "@/lib/db";
import { num, when } from "@/lib/format";
import { RANGES, readFilters } from "@/lib/range";

export const dynamic = "force-dynamic";

// Colors follow the app (its place in the sorted list of all apps), never its rank or the filter, and never
// past the first four categorical slots; further apps stay in the table and the bar list.
const SLOTS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];

type Latest = { app_id: string; psi: number; alert: number; baseline: number; current: number; note: string; at: string };

export default async function Drift({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = readFilters(await searchParams);
  const range = RANGES[filters.range];

  const [history, latest] = await Promise.all([
    query<{ t: number; app_id: string; psi: number }>(`
      SELECT toUnixTimestamp(created_at) * 1000 AS t, app_id, psi FROM drift
      WHERE psi >= 0 AND created_at > now() - INTERVAL ${range.interval} ORDER BY t`),
    query<Latest>(`
      SELECT app_id, argMax(psi, created_at) AS psi, argMax(alert, created_at) AS alert, argMax(baseline_count, created_at) AS baseline,
             argMax(current_count, created_at) AS current, argMax(note, created_at) AS note, toString(max(created_at)) AS at
      FROM drift GROUP BY app_id ORDER BY psi DESC`),
  ]);

  const allApps = [...new Set(history.map((h) => h.app_id))].sort();
  const shown = allApps.slice(0, SLOTS.length);
  const rows = new Map<number, { t: number } & Record<string, number | null>>();
  for (const h of history) {
    if (!shown.includes(h.app_id)) continue;
    const row = rows.get(h.t) ?? { t: h.t };
    row[`a${shown.indexOf(h.app_id)}`] = h.psi;
    rows.set(h.t, row);
  }
  const chartData = [...rows.values()].sort((a, b) => a.t - b.t);

  const measured = latest.filter((l) => l.psi >= 0);
  const drifting = measured.filter((l) => l.alert === 1);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

  return (
    <>
      <PageHead title="Drift" subtitle="Has the kind of prompt changed? PSI compares the last 7 days of prompts with the 28 days before: under 0.1 is stable, 0.1 to 0.2 some change, above 0.2 significant drift.">
        <Toolbar path="/drift" filters={filters} showDemo={false} />
      </PageHead>

      <div className="tiles">
        <Tile label="Apps measured" value={num(measured.length)} note={`${num(latest.length - measured.length)} without enough prompts`} />
        <Tile label="Apps drifting" value={num(drifting.length)} note="latest PSI above 0.2" />
        <Tile label="Highest PSI" value={measured.length ? Math.max(...measured.map((m) => m.psi)).toFixed(2) : "-"} note="latest run per app" />
      </div>

      <div className="grid2">
        <ChartCard title="PSI per run" subtitle="Log scale; the red line is the alert threshold (0.2)" columns={["Run (UTC)", ...shown]}
          rows={chartData.map((r) => [iso(r.t), ...shown.map((_, i) => (r[`a${i}`] === null || r[`a${i}`] === undefined ? null : (r[`a${i}`] as number).toFixed(3)))])}
          empty={chartData.length === 0} tableNote={allApps.length > shown.length ? `Only the first ${shown.length} apps are drawn; the rest are in the latest-result table below.` : undefined}>
          <TimeChart kind="line" format="psi" logScale threshold={{ value: 0.2, label: "alert 0.2" }} bucketMinutes={120} ariaLabel="PSI of each app per drift run"
            data={chartData} series={shown.map((app, i) => ({ key: `a${i}`, name: app, color: SLOTS[i] }))} />
        </ChartCard>
        <section className="card">
          <div className="card-head"><div><h2>Latest PSI per app</h2><p className="sub">The red tick marks the alert threshold (0.2)</p></div></div>
          <BarList rows={measured.map((m) => ({ name: m.app_id, value: m.psi, display: m.psi.toFixed(2), alert: m.alert === 1 }))} mark={{ value: 0.2, label: "alert threshold 0.2" }} />
        </section>
      </div>

      <section className="card">
        <div className="card-head"><div><h2>Latest result per app</h2><p className="sub">Apps need at least 30 prompts in each window to be measured</p></div></div>
        {latest.length === 0 ? <Empty title="The drift job has not run yet" hint="Run make drift." /> : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>App</th><th className="num">PSI</th><th>Status</th><th className="num">Baseline prompts</th><th className="num">Current prompts</th><th>Checked</th><th>Least typical current prompts</th></tr></thead>
              <tbody>{latest.map((l) => (
                <tr key={l.app_id}>
                  <td>{l.app_id}</td>
                  <td className="num">{l.psi >= 0 ? l.psi.toFixed(3) : "-"}</td>
                  <td>{l.psi < 0 ? <Badge tone="none">no data</Badge> : l.alert ? <Badge tone="warn">drifting</Badge> : <Badge tone="good">stable</Badge>}</td>
                  <td className="num">{num(l.baseline)}</td><td className="num">{num(l.current)}</td>
                  <td className="mono nowrap">{when(l.at)}</td>
                  <td>{l.alert ? l.note.replace("least typical current prompts: ", "") : l.psi < 0 ? <span className="muted">{l.note}</span> : ""}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="sub" style={{ marginTop: 10, fontSize: 12.5 }}>The <code>drift-demo-*</code> apps are fake back-dated data used to test the detector.</p>
      </section>
    </>
  );
}
