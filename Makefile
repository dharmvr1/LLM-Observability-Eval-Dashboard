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
        eval pii drift measure-eval measure-pii measure-pii-cached noise-check clean

help:  ## show this list
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-20s %s\n", $$1, $$2}'

# ---------------------------------------------------------------- services
up:  ## start ClickHouse, the OTel collector and the fake S3 (sampling set to 100%)
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

# ---------------------------------------------------------------- quality checks
measure-eval:  ## how accurate are the DeepEval metrics? (16 labeled cases, uses tokens)
	@$(ENV) $(PY) -m app.measure.eval_measure

measure-pii:  ## how good is the PII check? (75 labeled cases, about 30,000 tokens)
	@$(ENV) $(PY) -m app.measure.pii_measure

measure-pii-cached:  ## same, but reuse the saved guard scores (0 tokens)
	@$(ENV) $(PY) -m app.measure.pii_measure cached

noise-check:  ## how often does PSI exceed 0.2 when nothing changed?
	@$(ENV) $(PY) -m app.measure.drift_noise_check

clean:  ## remove __pycache__ folders
	find app -name __pycache__ -type d -prune -exec rm -rf {} +
