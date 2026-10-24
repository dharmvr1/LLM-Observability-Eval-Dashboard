import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/Ui";
import Waterfall from "@/components/Waterfall";
import { query } from "@/lib/db";
import { lastMessage, maskSensitive, ms, num, usd, when } from "@/lib/format";
import { costUsd } from "@/lib/pricing";

export const dynamic = "force-dynamic";

type SpanRow = {
  span_id: string; parent_span_id: string; name: string; started: string; start_ms: number; latency_ms: number;
  status: string; app_id: string; user_id: string; model: string; tin: number; tout: number; input: string; output: string;
};
type EvalRow = { metric: string; score: number; passed: number; reason: string; scored_span_id: string };
type PiiCheck = { risk: number; regex_types: string[]; llm_score: number; reason: string; scored_span_id: string };
type Triage = { status: string; risk: number; types: string[]; reason: string };

export default async function TracePage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  const p = { t: traceId };

  const [spans, evals, checks, triage] = await Promise.all([
    query<SpanRow>(
      `SELECT span_id, parent_span_id, name, toString(start_time) AS started, toUnixTimestamp64Milli(start_time) AS start_ms,
              latency_ms, status, app_id, user_id, gen_ai_request_model AS model, input_tokens AS tin, output_tokens AS tout,
              attributes['gen_ai.input.messages'] AS input, attributes['gen_ai.output.messages'] AS output
       FROM spans WHERE trace_id = {t:String} ORDER BY start_time`, p),
    query<EvalRow>(`SELECT metric, score, passed, reason, scored_span_id FROM evals WHERE trace_id = {t:String} ORDER BY metric`, p),
    query<PiiCheck>(`SELECT risk, regex_types, llm_score, reason, scored_span_id FROM pii_checks WHERE trace_id = {t:String}`, p),
    query<Triage>(`SELECT status, risk, types, reason FROM pii_triage WHERE trace_id = {t:String}`, p),
  ]);
  if (spans.length === 0) notFound();

  const llmSpans = spans.filter((s) => s.model);
  return (
    <>
      <p className="sub"><Link href="/traces">&larr; all traces</Link></p>
      <h1>Trace <span className="mono">{traceId.slice(0, 12)}</span></h1>
      <p className="sub">{spans[0].app_id} · {when(spans[0].started)} · {spans.length} span{spans.length === 1 ? "" : "s"}</p>

      <div className="card">
        <h2>Waterfall</h2>
        {/* Pass only the fields the waterfall draws: never the prompt and answer text. */}
        <Waterfall spans={spans.map(({ span_id, parent_span_id, name, start_ms, latency_ms, status, model }) => ({ span_id, parent_span_id, name, start_ms, latency_ms, status, model }))} />
      </div>

      {triage.map((t, i) => (
        <div className="card" key={i} style={{ borderColor: "var(--bad)" }}>
          <h2>PII triage <span className={`badge ${t.status === "open" ? "bad" : "warn"}`}>{t.status}</span></h2>
          <p style={{ margin: 0 }}>{t.reason} (risk {t.risk.toFixed(2)}, types: {t.types.join(", ") || "-"}). <Link href="/alerts">Open alerts</Link></p>
        </div>
      ))}

      {llmSpans.map((s) => (
        <div className="card" key={s.span_id}>
          <h2>{s.name} <StatusBadge status={s.status} /></h2>
          <dl className="kv">
            <dt>Model</dt><dd>{s.model}</dd>
            <dt>User</dt><dd>{s.user_id || "-"}</dd>
            <dt>Latency</dt><dd>{ms(s.latency_ms)}</dd>
            <dt>Tokens</dt><dd>{num(s.tin)} in, {num(s.tout)} out · estimated cost {usd(costUsd(s.model, s.tin, s.tout))} (placeholder prices)</dd>
          </dl>
          <h2 style={{ marginTop: 14 }}>Prompt</h2>
          <pre className="text">{maskSensitive(lastMessage(s.input, "user")) || "(none stored)"}</pre>
          {lastMessage(s.input, "system") ? (
            <details>
              <summary>System message / context</summary>
              <pre className="text">{maskSensitive(lastMessage(s.input, "system"))}</pre>
            </details>
          ) : null}
          <h2>Answer</h2>
          <pre className="text">{maskSensitive(lastMessage(s.output, "assistant")) || "(none stored)"}</pre>
          <p className="sub" style={{ margin: 0 }}>SSN-like numbers and long digit runs are masked on this page; the stored text is unchanged.</p>

          {evals.filter((e) => e.scored_span_id === s.span_id).length > 0 ? (
            <>
              <h2 style={{ marginTop: 14 }}>Eval scores</h2>
              <table>
                <thead><tr><th>Metric</th><th className="num">Score</th><th>Result</th><th>Reason</th></tr></thead>
                <tbody>
                  {evals.filter((e) => e.scored_span_id === s.span_id).map((e) => (
                    <tr key={e.metric}>
                      <td>{e.metric}</td>
                      <td className="num">{e.score.toFixed(2)}</td>
                      <td><span className={`badge ${e.passed ? "good" : "bad"}`}>{e.passed ? "passed" : "failed"}</span></td>
                      <td>{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          {checks.filter((c) => c.scored_span_id === s.span_id).map((c, i) => (
            <p key={i} style={{ margin: "12px 0 0" }}>
              <strong>PII check:</strong> risk {c.risk.toFixed(2)}
              {c.regex_types.length ? ` · regex found ${c.regex_types.join(", ")}` : ""}
              {c.llm_score >= 0 ? ` · guard score ${c.llm_score.toFixed(2)}` : " · guard skipped"} — {c.reason}
            </p>
          ))}
        </div>
      ))}
    </>
  );
}
