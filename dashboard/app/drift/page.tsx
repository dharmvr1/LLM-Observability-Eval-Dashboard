import Link from "next/link";
import TimeChart from "@/components/Charts";
import { Tile, Toolbar } from "@/components/Ui";
import { query } from "@/lib/db";
import { num, when } from "@/lib/format";
import { RANGES, readFilters } from "@/lib/range";

export const dynamic = "force-dynamic";

const COLORS = ["#2f6fed", "#c0392b", "#1a7f4b", "#8e44ad", "#b45f06", "#16a085", "#7f8c8d"];

type Latest = { app_id: string; psi: number; alert: number; baseline: number; current: number; note: string; at: string };

export default async function Drift({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = readFilters(await searchParams);
  const range = RANGES[filters.range];

  const [history, latest] = await Promise.all([
    query<{ t: number; app_id: string; psi: number }>(`
      SELECT toUnixTimestamp(created_at) * 1000 AS t, app_id, psi
      FROM drift WHERE psi >= 0 AND created_at > now() - INTERVAL ${range.interval} ORDER BY t`),
    query<Latest>(`
      SELECT app_id, argMax(psi, created_at) AS psi, argMax(alert, created_at) AS alert,
             argMax(baseline_count, created_at) AS baseline, argMax(current_count, created_at) AS current,
             argMax(note, created_at) AS note, toString(max(created_at)) AS at
      FROM drift GROUP BY app_id ORDER BY psi DESC`),
  ]);

  // one chart row per run, one column (a0, a1, ...) per app
  const apps = [...new Set(history.map((h) => h.app_id))].sort();
  const rows = new Map<number, { t: number } & Record<string, number | null>>();
  for (const h of history) {
    const row = rows.get(h.t) ?? { t: h.t };
    row[`a${apps.indexOf(h.app_id)}`] = h.psi;
    rows.set(h.t, row);
  }
  const chartData = [...rows.values()].sort((a, b) => a.t - b.t);
  const series = apps.map((app, i) => ({ key: `a${i}`, name: app, color: COLORS[i % COLORS.length] }));

  const measured = latest.filter((l) => l.psi >= 0);
  const alerting = measured.filter((l) => l.alert === 1);

  return (
    <>
      <h1>Drift</h1>
      <p className="sub">
        Has the kind of prompt changed? PSI compares the last 7 days of prompts with the 28 days before. Below 0.1 is stable,
        0.1 to 0.2 some change, above 0.2 significant drift. Apps with too few prompts are not measured.
      </p>
      <Toolbar path="/drift" filters={filters} showDemo={false} />

      <div className="tiles">
        <Tile label="Apps measured" value={num(measured.length)} note={`${num(latest.length - measured.length)} without enough data`} />
        <Tile label="Apps drifting" value={num(alerting.length)} note="PSI above the threshold" tone={alerting.length > 0 ? "bad" : "good"} />
        <Tile label="Highest PSI" value={measured.length ? Math.max(...measured.map((m) => m.psi)).toFixed(2) : "-"} note="latest run per app" />
      </div>

      <div className="card">
        <h2>PSI per run (log scale)</h2>
        <TimeChart data={chartData} series={series} threshold={{ value: 0.2, label: "alert at 0.2" }} logScale bucketMinutes={120} />
        <p className="sub" style={{ margin: "6px 0 0" }}>Each point is one run of the drift job (<code>make drift</code>).</p>
      </div>

      <div className="card">
        <h2>Latest result per app</h2>
        {latest.length === 0 ? <div className="empty">The drift job has not run yet. Run <code>make drift</code>.</div> : (
          <table>
            <thead><tr><th>App</th><th className="num">PSI</th><th>Status</th><th className="num">Baseline prompts</th><th className="num">Current prompts</th><th>Checked</th><th>Least typical current prompts</th></tr></thead>
            <tbody>{latest.map((l) => (
              <tr key={l.app_id}>
                <td>{l.app_id}</td>
                <td className="num">{l.psi >= 0 ? l.psi.toFixed(3) : "-"}</td>
                <td>{l.psi < 0 ? <span className="badge muted">no data</span> : l.alert ? <span className="badge bad">drift</span> : <span className="badge good">stable</span>}</td>
                <td className="num">{num(l.baseline)}</td><td className="num">{num(l.current)}</td>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>{when(l.at)}</td>
                <td>{l.alert ? l.note.replace("least typical current prompts: ", "") : l.psi < 0 ? l.note : ""}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <p className="sub" style={{ margin: "10px 0 0" }}>The <code>drift-demo-*</code> apps are fake back-dated data. See <Link href="/alerts">Alerts</Link> for everything that needs attention.</p>
      </div>
    </>
  );
}
