# Step 9: the regression probe. "Deploy a bug, and see how fast the alert arrives."
#
#   python -m app.measure.regression_probe [--trials 3] [--rate 2] [--leak-rate 0.01]    (or: make probe TRIALS=3)
#
# A fake chatbot ("probe-bot", no LLM) answers support questions. After a clean baseline, the "bug is
# deployed": from then on 1% of its answers contain a fake SSN (random numbers in SSN format).
# The probe keeps sending traffic and writes down the moment of every step of the alert path:
#
#   leaking answer sent -> span stored in ClickHouse -> PII job puts it in the triage queue
#   -> exporter shows it, Prometheus scrapes it -> alert firing -> Alertmanager delivers it to the
#   local receiver -> Alertmanager's Slack counter goes up
#
# Then it plays the human: it marks the item confirmed, waits for the "resolved" message, and deletes
# its own test data. Each trial is saved in otel.probe_runs (the dashboard shows them).
# Everything runs on one machine, so one clock times every step.
#
# While it runs, the PII loop is replaced by one with the guard LLM OFF (PII_GUARD_SAMPLE=0). The leak
# is a regex hit, which never needs the LLM; this keeps the quota free and takes LLM speed out of the
# measurement. With the guard on, the regex pass still runs first, so detection is not delayed by it.
import argparse
import datetime
import json
import os
import random
import re
import socket
import statistics
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import clickhouse_connect
from app.lib import otlp

APP = "probe-bot"
PROMETHEUS = "http://127.0.0.1:9091"
ALERTMANAGER = "http://127.0.0.1:9093"
EXPORTER = "http://127.0.0.1:9108/metrics"
DEADLINE_SECONDS = 300  # the README's target: caught in under five minutes

db = clickhouse_connect.get_client(host="localhost", port=8123, username="default", password="dev")

QUESTIONS = [
    "Can I get a refund for my order?", "How long does shipping take?", "Is support open on Saturday?",
    "How do I reset my password?", "Where is my parcel?", "Do you ship to Canada?",
    "Can I change my delivery address?", "What is your return policy?",
]
CLEAN_ANSWERS = [
    "Refunds are possible within 30 days of purchase.", "Standard shipping takes 5 to 7 business days.",
    "Support is open Monday to Friday, 9am to 5pm.", "Use the reset link on the login page.",
    "You can track your parcel with the link in your confirmation email.", "Yes, we ship to Canada.",
]


def fake_ssn():
    """Random numbers in SSN format. They belong to nobody (and avoid the ranges that are never issued)."""
    return f"{random.randint(100, 665)}-{random.randint(10, 99)}-{random.randint(1000, 9999)}"


def leaking_answer():
    return f"Sure! Here is the customer record you asked for: SSN {fake_ssn()}, plan Premium."


# ---------------------------------------------------------------- reading the state of the alert chain
def get_text(url):
    return urllib.request.urlopen(url, timeout=5).read().decode()


def port_open(port):
    with socket.socket() as s:
        s.settimeout(2)
        return s.connect_ex(("127.0.0.1", port)) == 0


def slack_count():
    """How many Slack notifications Alertmanager has sent so far."""
    text = get_text(f"{ALERTMANAGER}/metrics")
    match = re.search(r'^alertmanager_notifications_total\{integration="slack"\} (\S+)', text, flags=re.M)
    return float(match.group(1)) if match else 0.0


def open_items_in_prometheus():
    query = urllib.parse.quote(f'pii_triage_items{{app_id="{APP}",status="open"}}')
    result = json.loads(get_text(f"{PROMETHEUS}/api/v1/query?query={query}"))["data"]["result"]
    return float(result[0]["value"][1]) if result else 0.0


def alert_state():
    """'firing', 'pending' or None for the PIILeakOpen alert of the probe app."""
    for alert in json.loads(get_text(f"{PROMETHEUS}/api/v1/alerts"))["data"]["alerts"]:
        if alert["labels"].get("alertname") == "PIILeakOpen" and alert["labels"].get("app_id") == APP:
            return alert["state"]
    return None


def scalar(sql, **params):
    return db.query(sql, parameters=params).result_rows[0][0]


def receiver_row_ms(status, since_ms):
    """Arrival time (epoch ms) of the first PIILeakOpen row of the probe app with this status, or 0."""
    return scalar(
        "SELECT toUnixTimestamp64Milli(min(received_at)) FROM otel.alert_events "
        "WHERE app_id = {a:String} AND alertname = 'PIILeakOpen' AND status = {s:String} "
        "AND received_at > fromUnixTimestamp64Milli({t:Int64})", a=APP, s=status, t=since_ms)


# ---------------------------------------------------------------- the PII loop (guard off while we measure)
def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop_normal_pii_loop():
    """Stop the loop that `make start` began, if it is running. Returns True if one was stopped."""
    path = ".run/pii.pid"
    if os.path.exists(path):
        pid = int(open(path).read())
        if pid_alive(pid):
            os.kill(pid, 15)
            os.remove(path)
            return True
    return False


def start_pii_loop(guard_off):
    env = dict(os.environ)
    if guard_off:
        env.update({"PII_GUARD_SAMPLE": "0", "PII_MAX_SPANS": "2000"})
    os.makedirs(".run", exist_ok=True)
    log = open(".run/probe-pii.log" if guard_off else ".run/pii.log", "w")
    process = subprocess.Popen([sys.executable, "-u", "-m", "app.jobs.pii_job", "loop"], env=env,
                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    if not guard_off:
        open(".run/pii.pid", "w").write(str(process.pid))
    return process


def collector_sample_pct():
    """The share of normal traces the collector keeps (SUCCESS_SAMPLE_PCT), read from its container."""
    try:
        out = subprocess.run(["docker", "inspect", "llm_observal_eval-otel-collector-1", "--format",
                              "{{range .Config.Env}}{{println .}}{{end}}"], capture_output=True, text=True).stdout
        return int(re.search(r"SUCCESS_SAMPLE_PCT=(\d+)", out).group(1))
    except Exception:
        return -1


def preflight():
    problems = []
    for name, ok in [("collector :4318", port_open(4318)), ("alert receiver :9199", port_open(9199))]:
        if not ok:
            problems.append(f"{name} is not reachable (run `make up` and `make start`)")
    for name, url in [("exporter", EXPORTER), ("Prometheus", f"{PROMETHEUS}/-/ready"), ("Alertmanager", f"{ALERTMANAGER}/-/ready")]:
        try:
            get_text(url)
        except Exception:
            problems.append(f"{name} is not reachable (run `make up` and `make start`)")
    if not problems:
        down = [t["labels"]["job"] for t in json.loads(get_text(f"{PROMETHEUS}/api/v1/targets"))["data"]["activeTargets"] if t["health"] != "up"]
        if down:
            problems.append(f"Prometheus cannot scrape: {down}")
        if alert_state() or scalar("SELECT count() FROM otel.pii_triage WHERE app_id = {a:String} AND status = 'open'", a=APP):
            problems.append(f"an alert or open triage item for {APP} already exists (a previous run was interrupted?)")
    if problems:
        sys.exit("preflight failed:\n  - " + "\n  - ".join(problems))


# ---------------------------------------------------------------- one trial
def send_second(rate, leak_rate, leaking_enabled):
    """Send `rate` fake answers (about one second of traffic). Returns the trace id of the first leaking one, if any."""
    spans, leak_trace = [], None
    for _ in range(rate):
        leaks = leaking_enabled and random.random() < leak_rate
        answer = leaking_answer() if leaks else random.choice(CLEAN_ANSWERS)
        span, trace_id = otlp.make_span(random.choice(QUESTIONS), answer, "u_probe")
        spans.append(span)
        if leaks and leak_trace is None:
            leak_trace = trace_id
    otlp.send(APP, spans)
    return leak_trace


def settle():
    """Wait until nothing of an earlier trial is left: no open item, no active alert, no stored probe data."""
    deadline = time.time() + 180
    while time.time() < deadline:
        open_rows = scalar("SELECT count() FROM otel.pii_triage WHERE app_id = {a:String} AND status = 'open'", a=APP)
        if not open_rows and alert_state() is None and open_items_in_prometheus() == 0:
            return
        time.sleep(3)
    sys.exit("could not reach a clean state before the trial (an alert for the probe app stays active)")


def drain_and_resolve(t_deploy):
    """Traffic has stopped. Wait until the PII job has checked every probe span (it may still be working on the
    last leaking answers), then act as the human: confirm every open item. Doing it earlier would leave items
    that open AFTER the confirmation, and the alert would stay active into the next trial."""
    time.sleep(8)  # the collector holds the last spans for about 6 seconds
    deadline = time.time() + 150
    while time.time() < deadline:
        unchecked = scalar("SELECT count() FROM otel.spans WHERE app_id = {a:String} AND span_id NOT IN "
                           "(SELECT scored_span_id FROM otel.pii_checks)", a=APP)
        if unchecked == 0:
            break
        time.sleep(3)
    db.command("ALTER TABLE otel.pii_triage UPDATE status = 'confirmed' WHERE app_id = {a:String} AND status = 'open' SETTINGS mutations_sync = 1",
               parameters={"a": APP})
    print("  all probe answers checked; confirmed the leak(s); waiting for the 'resolved' message ...", flush=True)
    deadline = time.time() + 240
    while time.time() < deadline and not receiver_row_ms("resolved", int(t_deploy * 1000)):
        time.sleep(2)


def run_trial(args, number, sample_pct):
    settle()
    print(f"\n=== trial {number}: {args.baseline}s of clean traffic, then the bug (1 in {round(1 / args.leak_rate)} answers leak)", flush=True)
    end = time.time() + args.baseline
    while time.time() < end:
        started = time.time()
        send_second(args.rate, args.leak_rate, leaking_enabled=False)
        time.sleep(max(0, 1 - (time.time() - started)))
    if alert_state() or open_items_in_prometheus() > 0:
        print("  INVALID TRIAL: an alert or an open item for the probe app existed before the bug was deployed")
        return None

    t_deploy = time.time()
    slack_before = slack_count()
    print(f"  bug deployed (leaking {args.leak_rate:.0%} of answers); sending {args.rate} requests/s ...", flush=True)
    t_leak, leak_trace = None, None
    seen = {"stored": None, "triage": None, "metric": None, "firing": None, "received": None, "slack": None}

    while time.time() - t_deploy < args.timeout:
        started = time.time()
        trace = send_second(args.rate, args.leak_rate, leaking_enabled=True)
        if trace and t_leak is None:
            t_leak, leak_trace = started, trace
            print(f"  first leaking answer sent {t_leak - t_deploy:.1f}s after the deploy", flush=True)
        if t_leak:
            now = time.time()
            if seen["stored"] is None and scalar("SELECT count() FROM otel.spans WHERE trace_id = {t:String}", t=leak_trace):
                seen["stored"] = now
            if seen["triage"] is None:
                created = scalar("SELECT toUnixTimestamp(min(created_at)) FROM otel.pii_triage "
                                 "WHERE app_id = {a:String} AND created_at >= toDateTime({t:Int64})", a=APP, t=int(t_deploy) - 1)
                if created > 0:
                    seen["triage"] = created  # the PII job's own timestamp (whole seconds)
            if seen["metric"] is None and open_items_in_prometheus() > 0:
                seen["metric"] = now
            if seen["firing"] is None and alert_state() == "firing":
                seen["firing"] = now
            if seen["received"] is None:
                received = receiver_row_ms("firing", int(t_deploy * 1000))
                if received > 0:
                    seen["received"] = received / 1000
            if seen["slack"] is None and slack_count() > slack_before:
                seen["slack"] = now
            if seen["received"] and seen["slack"]:
                break
        time.sleep(max(0, 1 - (time.time() - started)))

    # ---- the human: confirm the leak(s), wait for the "resolved" message
    drain_and_resolve(t_deploy)
    cleanup()  # this trial's data, so the next trial starts clean

    def after_leak(moment):
        return round(moment - t_leak, 1) if (moment and t_leak) else -1.0

    result = {
        "started_at": datetime.datetime.fromtimestamp(t_deploy, tz=datetime.timezone.utc),
        "sample_pct": sample_pct, "request_rate": float(args.rate), "leak_rate": args.leak_rate,
        "seconds_to_first_leak": round(t_leak - t_deploy, 1) if t_leak else -1.0,
        "stored_after_leak": after_leak(seen["stored"]), "triage_after_leak": after_leak(seen["triage"]),
        "metric_after_leak": after_leak(seen["metric"]), "firing_after_leak": after_leak(seen["firing"]),
        "received_after_leak": after_leak(seen["received"]), "slack_after_leak": after_leak(seen["slack"]),
        "deploy_to_slack": round(seen["slack"] - t_deploy, 1) if seen["slack"] else -1.0,
        "deploy_to_received": round(seen["received"] - t_deploy, 1) if seen["received"] else -1.0,
    }
    result["passed"] = int(0 < result["deploy_to_slack"] <= DEADLINE_SECONDS and 0 < result["deploy_to_received"] <= DEADLINE_SECONDS)
    result["note"] = "" if t_leak else "no leaking answer was sent before the timeout"
    db.insert("otel.probe_runs", [list(result.values())], column_names=list(result.keys()))
    return result


def cleanup():
    for sql in ["ALTER TABLE otel.spans DELETE WHERE app_id = {a:String}",
                "ALTER TABLE otel.otel_traces DELETE WHERE ServiceName = {a:String}",
                "ALTER TABLE otel.pii_checks DELETE WHERE app_id = {a:String}",
                "ALTER TABLE otel.pii_triage DELETE WHERE app_id = {a:String}"]:
        db.command(sql + " SETTINGS mutations_sync = 1", parameters={"a": APP})


def print_result(r):
    steps = [("answer stored in ClickHouse", "stored_after_leak"), ("in the PII triage queue", "triage_after_leak"),
             ("visible in Prometheus", "metric_after_leak"), ("alert firing", "firing_after_leak"),
             ("delivered to the receiver", "received_after_leak"), ("Slack notification sent", "slack_after_leak")]
    print(f"  collector keeps {r['sample_pct']}% of normal traces; first leak {r['seconds_to_first_leak']}s after the deploy")
    for label, key in steps:
        print(f"    {label:30} +{r[key]:6.1f} s after the leaking answer" if r[key] >= 0 else f"    {label:30}  never seen")
    verdict = "PASS" if r["passed"] else "FAIL"
    print(f"  bug deployed -> Slack: {r['deploy_to_slack']} s,  -> receiver: {r['deploy_to_received']} s   [{verdict}: target {DEADLINE_SECONDS} s]")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--trials", type=int, default=1)
    parser.add_argument("--rate", type=int, default=2, help="fake requests per second")
    parser.add_argument("--leak-rate", type=float, default=0.01, help="share of answers that leak after the bug")
    parser.add_argument("--baseline", type=int, default=20, help="seconds of clean traffic before the bug")
    parser.add_argument("--timeout", type=int, default=600, help="give up this many seconds after the deploy")
    parser.add_argument("--keep-data", action="store_true", help="do not delete the probe's spans and triage rows")
    args = parser.parse_args()

    preflight()
    sample_pct = collector_sample_pct()
    restore_normal_loop = stop_normal_pii_loop()
    pii_loop = start_pii_loop(guard_off=True)
    print(f"PII loop restarted with the guard LLM off (pid {pii_loop.pid}); loop period {os.environ.get('PII_LOOP_SECONDS', '60')} s")
    results = []
    try:
        for number in range(1, args.trials + 1):
            result = run_trial(args, number, sample_pct)
            if result is None:
                continue  # invalid trial: not counted
            print_result(result)
            results.append(result)
    finally:
        pii_loop.terminate()
        if restore_normal_loop:
            start_pii_loop(guard_off=False)
            print("\nthe normal PII loop (guard on) was started again")
        if not args.keep_data:
            cleanup()

    seen = [r["deploy_to_slack"] for r in results if r["deploy_to_slack"] > 0]
    print(f"\n{len(results)} trial(s): {sum(r['passed'] for r in results)} within {DEADLINE_SECONDS} s.", end=" ")
    if seen:
        print(f"Bug deployed -> Slack: median {statistics.median(seen):.0f} s, worst {max(seen):.0f} s.")


if __name__ == "__main__":
    main()
