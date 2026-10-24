"use client";

import { useState } from "react";

// Every chart has a table twin (the accessible equivalent). Charts read their numbers from the same
// columns and rows, so the two views always agree.
type Cell = string | number | null;

export default function ChartCard({
  title, subtitle, columns, rows, children, empty, tableNote,
}: {
  title: string; subtitle?: string; columns: string[]; rows: Cell[][]; children: React.ReactNode; empty?: boolean; tableNote?: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="sub">{subtitle}</p> : null}
        </div>
        {!empty ? (
          <div className="segmented" role="group" aria-label={`${title}: view`}>
            <button className={view === "chart" ? "on" : ""} onClick={() => setView("chart")} aria-pressed={view === "chart"}>Chart</button>
            <button className={view === "table" ? "on" : ""} onClick={() => setView("table")} aria-pressed={view === "table"}>Table</button>
          </div>
        ) : null}
      </div>
      {view === "chart" || empty ? (
        children
      ) : (
        <div className="scroll-x" style={{ maxHeight: 330, overflowY: "auto" }}>
          <table>
            <thead><tr>{columns.map((c, i) => <th key={c} className={i > 0 ? "num" : ""}>{c}</th>)}</tr></thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>{row.map((cell, i) => <td key={i} className={i > 0 ? "num" : ""}>{cell ?? "-"}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {tableNote ? <p className="sub" style={{ marginTop: 8, fontSize: 12 }}>{tableNote}</p> : null}
        </div>
      )}
    </section>
  );
}
