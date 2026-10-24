# Scale test: can the pipeline take 1,000 spans per second without a backlog?
#
#   python -m app.measure.scale_test [--rate 1000] [--seconds 120]      (or: make scale-test RATE=1000 SECONDS=120)
#
# It sends fake LLM-call spans (no LLM) to the OpenTelemetry collector in batches of 100 at a steady
# pace: a short ramp (25% and 50% of the rate), then the full rate for --seconds. Every second it
# counts how many spans the collector accepted and how many are already stored in ClickHouse; the
# difference is the BACKLOG. Every 5 seconds it also reads the collector's own metrics and
# `docker stats`. At the end it waits for everything to be stored and checks these criteria:
#
#   1. the generator really sustained the rate (at least 99% of it)
#   2. the collector refused nothing and no request failed
#   3. every accepted span is in ClickHouse within 60 seconds of the end (only checked at 100% sampling)
#   4. the backlog stayed flat: it grew by less than 5% of the rate, per second, in the second half
#   5. the collector's ClickHouse exporter queue never filled up
#   6. the second path, the S3 archive, also received every accepted span
#
# The test spans carry a realistic answer text (so the collector also runs its two keep-rules on it), which
# means the PII loop is paused while the test runs and started again afterwards. Test data is deleted at the end.
import argparse
import datetime
import http.client
import json
import os
import re
import statistics
import subprocess
import sys
import threading
import time
import urllib.request

import clickhouse_connect
from app.measure.regression_probe import start_pii_loop, stop_normal_pii_loop

APP = "scale-test"
HOST, PORT = "127.0.0.1", 4318
COLLECTOR_METRICS = "http://127.0.0.1:8888/metrics"
CONTAINERS = ["clickhouse-1", "otel-collector-1", "s3-1", "prometheus-1", "alertmanager-1"]

PROMPT = "Can I get a refund for my order? I bought it three weeks ago and the box was damaged when it arrived. " * 3
ATTRIBUTES = [  # about the size and shape of a real span without an answer
    {"key": "gen_ai.input.messages", "value": {"stringValue": json.dumps([{"role": "user", "parts": [{"content": PROMPT, "type": "text"}]}])}},
    {"key": "gen_ai.request.model", "value": {"stringValue": "stub-bot"}},
    {"key": "gen_ai.response.model", "value": {"stringValue": "stub-bot"}},
    {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
    {"key": "gen_ai.provider.name", "value": {"stringValue": "openai"}},
    {"key": "gen_ai.response.id", "value": {"stringValue": "chatcmpl-scale-test"}},
    {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "40"}},
    {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "120"}},
    {"key": "traceloop.association.properties.user_id", "value": {"stringValue": "u_scale"}},
]
ANSWER = ("Thanks for contacting us. Refunds are possible within 30 days of purchase, and damaged goods can be replaced free of charge. "
          "Please send a photo of the box and your order number and we will arrange a replacement within two working days. ") * 2
ANSWER_ATTRIBUTE = {"key": "gen_ai.output.messages", "value": {"stringValue": json.dumps(
    [{"role": "assistant", "parts": [{"content": ANSWER, "type": "text"}], "finish_reason": "stop"}])}}
RESOURCE = {"attributes": [{"key": "service.name", "value": {"stringValue": APP}}]}


def build_body(n, with_answers):
    """One OTLP request with n spans, each in its own trace (like real LLM calls)."""
    attributes = ATTRIBUTES + [ANSWER_ATTRIBUTE] if with_answers else ATTRIBUTES
    now = time.time_ns()
    spans = [{"traceId": os.urandom(16).hex(), "spanId": os.urandom(8).hex(), "name": "openai.chat", "kind": 3,
              "startTimeUnixNano": str(now), "endTimeUnixNano": str(now + 400_000_000),
              "attributes": attributes, "status": {"code": 1}} for _ in range(n)]
    return json.dumps({"resourceSpans": [{"resource": RESOURCE, "scopeSpans": [{"scope": {"name": "scale"}, "spans": spans}]}]}).encode()


# ---------------------------------------------------------------- reading the collector and docker
def read_metric(text, name, exporter=None):
    """Sum of all series of one collector metric (optionally only those of one exporter)."""
    total = 0.0
    for line in text.splitlines():
        if line.startswith(name + "{") and (exporter is None or f'exporter="{exporter}"' in line):
            total += float(line.rsplit(" ", 1)[1])
    return total


def collector_snapshot():
    text = urllib.request.urlopen(COLLECTOR_METRICS, timeout=5).read().decode()
    return {
        "accepted": read_metric(text, "otelcol_receiver_accepted_spans"),
        "refused": read_metric(text, "otelcol_receiver_refused_spans"),
        "sent_clickhouse": read_metric(text, "otelcol_exporter_sent_spans", "clickhouse"),
        "sent_s3": read_metric(text, "otelcol_exporter_sent_spans", "awss3"),
        "failed": read_metric(text, "otelcol_exporter_send_failed_spans"),
        "enqueue_failed": read_metric(text, "otelcol_exporter_enqueue_failed_spans"),
        "queue_size": read_metric(text, "otelcol_exporter_queue_size", "clickhouse"),
        "queue_capacity": read_metric(text, "otelcol_exporter_queue_capacity", "clickhouse"),
        "traces_in_memory": read_metric(text, "otelcol_processor_tail_sampling_sampling_traces_on_memory"),
        "dropped_too_early": read_metric(text, "otelcol_processor_tail_sampling_sampling_trace_dropped_too_early"),
        "cpu_seconds": read_metric(text, "otelcol_process_cpu_seconds"),
        "rss_bytes": read_metric(text, "otelcol_process_memory_rss"),
    }


def docker_snapshot():
    out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}} {{.CPUPerc}} {{.MemUsage}}"],
                         capture_output=True, text=True).stdout
    result = {}
    for line in out.splitlines():
        name, cpu, mem = line.split(" ", 2)
        short = name.replace("llm_observal_eval-", "")
        if short in CONTAINERS:
            used = mem.split("/")[0].strip()
            mib = float(re.sub(r"[A-Za-z]+", "", used)) * (1024 if "GiB" in used else 1)
            result[short] = (float(cpu.strip("%")), mib)
    return result


def collector_sample_pct():
    try:
        out = subprocess.run(["docker", "inspect", "llm_observal_eval-otel-collector-1", "--format",
                              "{{range .Config.Env}}{{println .}}{{end}}"], capture_output=True, text=True).stdout
        return int(re.search(r"SUCCESS_SAMPLE_PCT=(\d+)", out).group(1))
    except Exception:
        return -1


# ---------------------------------------------------------------- the test
def send_stage(rate, seconds, state, stage_name):
    """Send at `rate` spans per second for `seconds`. Batches are paced on an absolute schedule."""
    batch = state["batch"]
    interval = batch / rate
    conn = http.client.HTTPConnection(HOST, PORT, timeout=30)
    start = time.perf_counter()
    state["stage_start_accepted"][stage_name] = state["accepted"]
    state["stage_times"][stage_name] = [time.time(), None]
    k = 0
    while k * interval < seconds:
        wait = start + k * interval - time.perf_counter()
        if wait > 0:
            time.sleep(wait)
        else:
            state["max_behind"] = max(state["max_behind"], -wait)  # the generator itself is late
        body = build_body(batch, state["answers"])
        began = time.perf_counter()
        try:
            conn.request("POST", "/v1/traces", body, {"Content-Type": "application/json"})
            response = conn.getresponse()
            response.read()
            ok = response.status == 200
        except Exception:
            conn.close()
            conn = http.client.HTTPConnection(HOST, PORT, timeout=30)
            ok = False
        state["latencies"].setdefault(stage_name, []).append(time.perf_counter() - began)
        if ok:
            state["accepted"] += batch
        else:
            state["failed_requests"] += 1
        k += 1
    # The stage lasts until the end of its schedule (k batches of `interval`), or until the last answer
    # if the collector was slower than that. Dividing by the time of the last request would overstate the rate.
    duration = max(time.perf_counter() - start, k * interval)
    state["stage_times"][stage_name][1] = state["stage_times"][stage_name][0] + duration
    state["stage_end_accepted"][stage_name] = state["accepted"]
    conn.close()


def sampler(state, stop):
    """Runs in a thread: every second the backlog; every 5 seconds the collector's metrics and docker stats."""
    db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")
    tick = 0
    while not stop.is_set():
        started = time.time()
        stored = db.query("SELECT count() FROM otel.otel_traces WHERE ServiceName = {a:String}", parameters={"a": APP}).result_rows[0][0]
        state["series"].append((started, state["accepted"], stored))
        if tick % 5 == 0:
            try:
                state["collector"].append((started, collector_snapshot()))
                state["docker"].append((started, docker_snapshot()))
            except Exception as e:
                print(f"  (could not read metrics: {type(e).__name__})", flush=True)
        tick += 1
        stop.wait(max(0, 1 - (time.time() - started)))


def percentile(values, p):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(len(ordered) * p))]


def run(args):
    """The test itself."""
    db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")
    try:
        before = collector_snapshot()
    except Exception as e:
        sys.exit(f"cannot read the collector's metrics at {COLLECTOR_METRICS}: {e} (run `make up`)")
    if db.query("SELECT count() FROM otel.otel_traces WHERE ServiceName = {a:String}", parameters={"a": APP}).result_rows[0][0]:
        sys.exit("data of an earlier run is still there; run with --keep-data off once, or delete app 'scale-test'")
    sample_pct = collector_sample_pct()
    print(f"collector keeps {sample_pct}% of normal traces; sending {args.rate} spans/s in batches of {args.batch}, "
          f"ramp 10 s at 25% and 10 s at 50%, then {args.seconds} s at full rate", flush=True)

    state = {"batch": args.batch, "answers": not args.no_answers, "accepted": 0, "failed_requests": 0, "max_behind": 0.0, "latencies": {},
             "series": [], "collector": [], "docker": [], "stage_start_accepted": {}, "stage_end_accepted": {}, "stage_times": {}}
    stop = threading.Event()
    thread = threading.Thread(target=sampler, args=(state, stop), daemon=True)
    thread.start()
    test_start = time.time()
    send_stage(args.rate * 0.25, 10, state, "ramp25")
    send_stage(args.rate * 0.5, 10, state, "ramp50")
    print("  ramp done, full rate now", flush=True)
    send_stage(args.rate, args.seconds, state, "steady")
    last_send = time.time()
    print(f"  sending finished ({state['accepted']:,} spans accepted); waiting for ClickHouse to catch up ...", flush=True)

    # ---- drain: wait until every accepted span is stored (at 100% sampling), at most 60 s
    drain_seconds, previous, unchanged = -1.0, -1, 0
    while time.time() - last_send < 60:
        stored = state["series"][-1][2] if state["series"] else 0
        if sample_pct == 100 and stored >= state["accepted"]:
            drain_seconds = round(time.time() - last_send, 1)
            break
        unchanged = unchanged + 1 if stored == previous else 0
        if sample_pct != 100 and unchanged >= 10:
            drain_seconds = round(time.time() - last_send - 10, 1)  # nothing new for 10 s: everything that will arrive has
            break
        previous = stored
        time.sleep(1)
    time.sleep(2)
    stop.set()
    thread.join(timeout=10)
    after = collector_snapshot()
    stored = db.query("SELECT count() FROM otel.otel_traces WHERE ServiceName = {a:String}", parameters={"a": APP}).result_rows[0][0]
    time.sleep(2)
    in_spans = db.query("SELECT count() FROM otel.spans WHERE app_id = {a:String}", parameters={"a": APP}).result_rows[0][0]

    # ---- numbers
    steady_s = state["stage_end_accepted"]["steady"] - state["stage_start_accepted"]["steady"]
    steady_seconds = state["stage_times"]["steady"][1] - state["stage_times"]["steady"][0]
    achieved = steady_s / steady_seconds
    lat = state["latencies"]["steady"]
    t0, t1 = state["stage_times"]["steady"]
    # At 100% sampling every accepted span must be stored. Below that the collector drops spans on purpose, so the
    # backlog is "expected stored minus stored" (accepted spans times the sampling share), not "accepted minus stored".
    share = sample_pct / 100 if 0 < sample_pct < 100 else 1.0
    half = [(t, a * share - s) for t, a, s in state["series"] if t0 + 0.4 * (t1 - t0) <= t <= t1]
    slope = statistics.linear_regression([t - half[0][0] for t, _ in half], [b for _, b in half]).slope if len(half) > 5 else 0.0
    backlog_median = statistics.median([b for _, b in half]) if half else 0.0
    queue_max = max([c["queue_size"] for _, c in state["collector"]] or [0])
    queue_capacity = after["queue_capacity"]
    cpu_cores = (after["cpu_seconds"] - before["cpu_seconds"]) / (time.time() - test_start)
    peak = {name: max([d[name][0] for _, d in state["docker"] if name in d] or [0]) for name in CONTAINERS}
    peak_mem = {name: max([d[name][1] for _, d in state["docker"] if name in d] or [0]) for name in CONTAINERS}
    refused = after["refused"] - before["refused"]
    send_failed = (after["failed"] - before["failed"]) + (after["enqueue_failed"] - before["enqueue_failed"])

    print("\n=== results")
    print(f"  spans accepted by the collector : {state['accepted']:,}   failed requests: {state['failed_requests']}   refused by collector: {refused:.0f}")
    print(f"  steady stage                    : {achieved:,.0f} spans/s achieved over {steady_seconds:.0f} s (generator was at most {state['max_behind'] * 1000:.0f} ms behind schedule)")
    print(f"  collector answer time per batch : p50 {percentile(lat, 0.5) * 1000:.0f} ms, p99 {percentile(lat, 0.99) * 1000:.0f} ms")
    print(f"  stored in otel_traces           : {stored:,}  (otel.spans copy: {in_spans:,})  drained {drain_seconds} s after the last send")
    print(f"  backlog ({'accepted' if share == 1 else f'accepted x {share:.0%}'} - stored) : median {backlog_median:,.0f} spans, slope {slope:+.1f} spans/s per second")
    print(f"  exporter queue (clickhouse)     : max {queue_max:.0f} of {queue_capacity:.0f}; send failures {send_failed:.0f}; traces dropped too early {after['dropped_too_early'] - before['dropped_too_early']:.0f}")
    print(f"  spans sent by the collector     : to ClickHouse {after['sent_clickhouse'] - before['sent_clickhouse']:,.0f}, to the S3 archive {after['sent_s3'] - before['sent_s3']:,.0f} (accepted {state['accepted']:,})")
    print(f"  tail sampling, traces in memory : max {max([c['traces_in_memory'] for _, c in state['collector']] or [0]):,.0f}")
    print(f"  collector process               : {cpu_cores:.2f} CPU cores on average, RSS up to {max([c['rss_bytes'] for _, c in state['collector']] or [0]) / 1e6:.0f} MB")
    print("  docker stats (peak CPU %, 100 = one core / peak memory MiB): " + ", ".join(f"{n} {peak[n]:.0f}% / {peak_mem[n]:.0f}" for n in CONTAINERS))

    checks = [
        ("1. sustained at least 99% of the rate", achieved >= 0.99 * args.rate),
        ("2. nothing refused, no failed request", refused == 0 and state["failed_requests"] == 0 and send_failed == 0),
        ("3. every accepted span stored within 60 s of the end" + ("" if sample_pct == 100 else f" (not checked: sampling is {sample_pct}%)"),
         True if sample_pct != 100 else (0 <= drain_seconds <= 60 and stored >= state["accepted"])),
        ("4. backlog flat (slope under 5% of the rate per second)", abs(slope) < 0.05 * args.rate),
        ("5. exporter queue never full", queue_capacity == 0 or queue_max < 0.9 * queue_capacity),
        ("6. the S3 archive got every accepted span too", (after["sent_s3"] - before["sent_s3"]) >= state["accepted"]),
    ]
    print()
    for label, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    passed = all(ok for _, ok in checks)
    print(f"\n  {'PASSED' if passed else 'FAILED'}: {args.rate} spans per second {'sustained without a backlog' if passed else 'not sustained'}")

    db.insert("otel.scale_runs", [[
        datetime.datetime.fromtimestamp(test_start, tz=datetime.timezone.utc), sample_pct, float(args.rate), float(steady_seconds),
        float(achieved), float(percentile(lat, 0.5) * 1000), float(percentile(lat, 0.99) * 1000), state["accepted"],
        state["failed_requests"], int(refused), stored, in_spans, float(drain_seconds), float(backlog_median), float(slope),
        float(queue_max), float(cpu_cores), float(peak["clickhouse-1"]), int(passed),
        "no answer text in the spans" if args.no_answers else "with answer text; PII loop paused",
    ]], column_names=["started_at", "sample_pct", "target_rate", "steady_seconds", "achieved_rate", "request_p50_ms", "request_p99_ms",
                      "accepted", "failed_requests", "refused_by_collector", "stored", "in_spans_table", "drain_seconds",
                      "backlog_median", "backlog_slope", "queue_max", "collector_cpu_cores", "clickhouse_cpu_max_pct", "passed", "note"])

    if not args.keep_data:
        for sql in ["ALTER TABLE otel.spans DELETE WHERE app_id = {a:String}", "ALTER TABLE otel.otel_traces DELETE WHERE ServiceName = {a:String}"]:
            db.command(sql + " SETTINGS mutations_sync = 1", parameters={"a": APP})
        print("  test data deleted")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rate", type=int, default=1000, help="spans per second")
    parser.add_argument("--seconds", type=int, default=120, help="length of the steady stage")
    parser.add_argument("--batch", type=int, default=100, help="spans per request")
    parser.add_argument("--no-answers", action="store_true", help="leave the answer text out of the test spans")
    parser.add_argument("--keep-data", action="store_true")
    args = parser.parse_args()

    # With answers, the PII job would try to check 100,000+ fake answers (and spend LLM tokens), so pause it.
    paused = False
    if not args.no_answers:
        paused = stop_normal_pii_loop()
        print("PII loop paused while the test runs" if paused else "PII loop was not running")
    try:
        run(args)
    finally:
        if paused:
            start_pii_loop(guard_off=False)
            print("PII loop started again")
        clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev").command(
            "ALTER TABLE otel.pii_checks DELETE WHERE app_id = {a:String} SETTINGS mutations_sync = 1", parameters={"a": APP})


if __name__ == "__main__":
    main()
