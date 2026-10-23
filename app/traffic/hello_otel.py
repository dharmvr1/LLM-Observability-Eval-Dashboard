# Step 1: one traced LLM call. Run with `make hello`, then look at the span in ClickHouse.
import os

from openai import OpenAI
from traceloop.sdk import Traceloop

# We only collect traces for now, so turn off the metrics export.
os.environ["TRACELOOP_METRICS_ENABLED"] = "false"

# One line patches the OpenAI SDK; spans go to the collector over OTLP HTTP.
Traceloop.init(
    app_name="hello-otel",
    api_endpoint="http://localhost:4318",
    disable_batch=True,  # send immediately; fine for a demo
)

# Groq by default; the key comes from GROQ_API_KEY in .env (run it with `make hello`).
client = OpenAI(
    base_url=os.environ.get("LLM_BASE_URL", "https://api.groq.com/openai/v1"),
    api_key=os.environ.get("LLM_API_KEY") or os.environ["GROQ_API_KEY"],
)

resp = client.chat.completions.create(
    model=os.environ.get("LLM_MODEL", "openai/gpt-oss-20b"),
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(resp.choices[0].message.content)
