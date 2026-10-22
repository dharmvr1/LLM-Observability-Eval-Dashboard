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

client = OpenAI(base_url=os.environ["LLM_BASE_URL"], api_key=os.environ["LLM_API_KEY"])

resp = client.chat.completions.create(
    model=os.environ["LLM_MODEL"],
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(resp.choices[0].message.content)
