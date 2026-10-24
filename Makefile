# One short command per task. Run `make` (or `make help`) to see them.
# Everything is run from this folder, using the project's virtualenv and the keys in .env.
#
#   make up && make schema     start the services, create the tables
#   make traffic               send some fake chatbot traffic (calls an LLM)
#   make eval | make pii | make drift     run one job
#   make eval GATEWAY=1        same, but the judge LLM is the local freellmapi gateway

SHELL := /bin/bash
PY    := .venv/bin/python
# Load .env quietly (a bad line in it must not stop the command).
ENV   := set -a; source .env >/dev/null 2>&1; set +a;

# With GATEWAY=1 the judges (eval and PII) use the local gateway instead of Groq.
ifdef GATEWAY
ENV += export JUDGE_BASE_URL=http://localhost:3001/v1 JUDGE_MODEL=gpt-oss-120b PII_JUDGE_MODEL=gpt-oss-120b JUDGE_API_KEY="$$FREELLMAPI_KEY" COVERAGE_BASE_URL=http://localhost:3001/v1 COVERAGE_MODEL=gpt-oss-20b COVERAGE_API_KEY="$$FREELLMAPI_KEY";
endif

CLICKHOUSE := docker compose exec -T clickhouse clickhouse-client --user default --password dev

.DEFAULT_GOAL := help
.PHONY: help up down ps schema query hello coverage traffic traffic-pii traffic-drift traffic-drift-clean \
        eval pii pii-loop exporter receiver start stop status alerts-config alerts-test drift dashboard-install dashboard dashboard-build dashboard-start \
        measure-eval measure-pii measure-pii-cached noise-check check-docs probe scale-test clean

help:  ## show this list
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-20s %s\n", $$1, $$2}'

# ---------------------------------------------------------------- services
up: alerts-config  ## start ClickHouse, collector, fake S3, Prometheus and Alertmanager (sampling set to 100%)
	docker compose --env-file .env.compose up -d

down:  ## stop the services (data in ClickHouse is kept)
	docker compose --env-file .env.compose down

ps:  ## show the services
	docker compose ps

schema:  ## create the ClickHouse tables (safe to run again; needs `make up` first)
	@for f in sql/*.sql; do echo "applying $$f"; $(CLICKHOUSE) --multiquery < $$f || exit 1; done

query:  ## open a ClickHouse SQL prompt (try the queries in sql/examples/queries.sql)
	docker compose exec clickhouse clickhouse-client --user default --password dev --database otel

# ---------------------------------------------------------------- fake traffic
hello:  ## step 1: one traced LLM call
	@$(ENV) $(PY) -m app.traffic.hello_otel

coverage:  ## step 3: one call through each SDK (OpenAI, Anthropic, Google, LangChain, LlamaIndex)
	@$(ENV) $(PY) -m app.traffic.sdk_coverage

traffic:  ## a support bot answering 7 questions (calls an LLM)
	@$(ENV) $(PY) -m app.traffic.make_traffic

traffic-pii:  ## a lookup bot that may leak a FAKE customer record (calls an LLM)
	@$(ENV) $(PY) -m app.traffic.make_pii_traffic

traffic-drift:  ## fake back-dated history for 3 demo apps (no LLM)
	@$(ENV) $(PY) -m app.traffic.make_drift_traffic

traffic-drift-clean:  ## delete the drift demo data
	@$(ENV) $(PY) -m app.traffic.make_drift_traffic clean

# ---------------------------------------------------------------- jobs
eval:  ## step 4: score recent responses with DeepEval  (add GATEWAY=1 for the local gateway)
	@$(ENV) $(PY) -m app.jobs.eval_job

pii:  ## step 5: check recent responses for PII leaks and fill the triage queue
	@$(ENV) $(PY) -m app.jobs.pii_job

drift:  ## step 6: has the kind of prompt changed? (PSI on prompt embeddings, no LLM)
	@$(ENV) $(PY) -m app.jobs.drift_job

# ---------------------------------------------------------------- alerting (step 8)
alerts-config:  ## write alertmanager/active.yml and its secret files from SLACK_WEBHOOK_URL (and PAGERDUTY_ROUTING_KEY) in .env
	@mkdir -p alertmanager/secrets
	@$(ENV) \
	 [ -n "$$SLACK_WEBHOOK_URL" ] || { echo "SLACK_WEBHOOK_URL is missing in .env (see .env.example)"; exit 1; }; \
	 printf '%s' "$$SLACK_WEBHOOK_URL" > alertmanager/secrets/slack_url; \
	 if [ -n "$$PAGERDUTY_ROUTING_KEY" ]; then \
	   printf '%s' "$$PAGERDUTY_ROUTING_KEY" > alertmanager/secrets/pagerduty_key; \
	   cp alertmanager/alertmanager.pagerduty.yml alertmanager/active.yml; \
	   echo "alerts-config: warnings -> Slack, critical -> PagerDuty and Slack"; \
	 else \
	   cp alertmanager/alertmanager.slack.yml alertmanager/active.yml; \
	   echo "alerts-config: no PAGERDUTY_ROUTING_KEY, so critical alerts go to Slack too"; \
	 fi; \
	 chmod 644 alertmanager/secrets/* alertmanager/active.yml; chmod 755 alertmanager/secrets  # the container user must be able to read them

start:  ## start the exporter, the alert receiver and the PII loop in the background (logs and pids in .run/)
	@mkdir -p .run
	@for f in .run/*.pid; do [ -f "$$f" ] || continue; if kill -0 $$(cat $$f) 2>/dev/null; then echo "already running: $$(basename $$f .pid) (run 'make stop' first)"; exit 1; else rm -f $$f; fi; done
	@$(ENV) nohup $(PY) -u -m app.jobs.metrics_exporter > .run/exporter.log 2>&1 & echo $$! > .run/exporter.pid
	@$(ENV) nohup $(PY) -u -m app.jobs.alert_receiver > .run/receiver.log 2>&1 & echo $$! > .run/receiver.pid
	@$(ENV) nohup $(PY) -u -m app.jobs.pii_job loop > .run/pii.log 2>&1 & echo $$! > .run/pii.pid
	@sleep 2; $(MAKE) --no-print-directory status

stop:  ## stop what `make start` started
	@for f in .run/*.pid; do [ -f "$$f" ] && kill $$(cat $$f) 2>/dev/null && echo "stopped $$(basename $$f .pid)"; rm -f $$f; done; true

status:  ## which background processes are running
	@for f in .run/*.pid; do [ -f "$$f" ] || continue; n=$$(basename $$f .pid); if kill -0 $$(cat $$f) 2>/dev/null; then echo "  $$n: running (pid $$(cat $$f))"; else echo "  $$n: NOT running (see .run/$$n.log)"; fi; done; true

exporter:  ## run the Prometheus exporter (leave it running): http://127.0.0.1:9108/metrics
	@$(ENV) $(PY) -m app.jobs.metrics_exporter

receiver:  ## run the local alert receiver (leave it running): stores alerts in otel.alert_events
	@$(ENV) $(PY) -m app.jobs.alert_receiver

pii-loop:  ## run the PII check every minute (leave it running)
	@$(ENV) $(PY) -m app.jobs.pii_job loop

alerts-test:  ## send ONE clearly labelled test alert through Alertmanager (it reaches Slack too)
	curl -s -XPOST http://127.0.0.1:9093/api/v2/alerts -H 'Content-Type: application/json' \
	  -d '[{"labels":{"alertname":"TestAlert","severity":"warning","family":"test","app_id":"alert-test","run":"'$$(date +%s)'"},"annotations":{"summary":"This is a test of the alert chain, please ignore."}}]' && echo "sent"

# ---------------------------------------------------------------- dashboard (step 7)
dashboard-install:  ## install the dashboard's Node packages (once)
	cd dashboard && npm install

dashboard:  ## run the dashboard in development mode at http://127.0.0.1:3100
	cd dashboard && npm run dev

dashboard-build:  ## build the dashboard for production (also type-checks it)
	cd dashboard && npm run build

dashboard-start:  ## run the built dashboard at http://127.0.0.1:3100 (after `make dashboard-build`)
	cd dashboard && npm run start

# ---------------------------------------------------------------- quality checks
measure-eval:  ## how accurate are the DeepEval metrics? (16 labeled cases, uses tokens)
	@$(ENV) $(PY) -m app.measure.eval_measure

measure-pii:  ## how good is the PII check? (75 labeled cases, about 30,000 tokens)
	@$(ENV) $(PY) -m app.measure.pii_measure

measure-pii-cached:  ## same, but reuse the saved guard scores (0 tokens)
	@$(ENV) $(PY) -m app.measure.pii_measure cached

noise-check:  ## how often does PSI exceed 0.2 when nothing changed?
	@$(ENV) $(PY) -m app.measure.drift_noise_check

RATE ?= 1000
SECONDS_STEADY ?= 120
scale-test:  ## README scale criterion: send RATE spans/s for SECONDS_STEADY seconds and look for a backlog (e.g. make scale-test RATE=2000)
	@$(ENV) $(PY) -u -m app.measure.scale_test --rate $(RATE) --seconds $(SECONDS_STEADY)

TRIALS ?= 1
probe:  ## step 9: deploy a fake bug (1% of answers leak a fake SSN) and time the alert; TRIALS=3 for several runs (sends real Slack messages)
	@$(ENV) $(PY) -u -m app.measure.regression_probe --trials $(TRIALS)

check-docs:  ## are the links in docs/ still valid after moving files?
	@$(PY) -m app.measure.check_docs

clean:  ## remove __pycache__ folders
	find app -name __pycache__ -type d -prune -exec rm -rf {} +
