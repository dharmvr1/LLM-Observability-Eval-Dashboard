# Step 3: call the LLM through each SDK family and check that spans land in ClickHouse.
# Each SDK has its own small function. If its API key is missing, it is skipped.
import os

from traceloop.sdk import Traceloop

os.environ["TRACELOOP_METRICS_ENABLED"] = "false"
Traceloop.init(app_name="sdk-coverage", api_endpoint="http://localhost:4318", disable_batch=True)

# Tag every span from this script with a user id (shows up in the user_id column).
Traceloop.set_association_properties({"user_id": "u_42"})

PROMPT = "Say hello in five words."

# Groq and OpenRouter both speak the OpenAI protocol, so we use them for
# the OpenAI, LangChain, LlamaIndex and vLLM-style tests.
BASE_URL = "https://api.groq.com/openai/v1"
MODEL = "openai/gpt-oss-20b"
API_KEY = os.environ.get("GROQ_API_KEY", "")


def test_openai():
    from openai import OpenAI

    client = OpenAI(base_url=BASE_URL, api_key=API_KEY)
    r = client.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": PROMPT}])
    return r.choices[0].message.content


def test_anthropic():
    from anthropic import Anthropic

    # No Anthropic credit? OpenRouter speaks the Anthropic protocol too, so the
    # Anthropic SDK still gets exercised (and instrumented) with an OpenRouter key.
    client = Anthropic(base_url="https://openrouter.ai/api", auth_token=os.environ["OPENROUTER_API_KEY"])
    r = client.messages.create(
        model=os.environ.get("OPENROUTER_MODEL", "google/gemma-4-26b-a4b-it:free"),
        max_tokens=50,
        messages=[{"role": "user", "content": PROMPT}],
    )
    return r.content[0].text


def test_google():
    from google import genai

    client = genai.Client(api_key=os.environ["Gemini_API_KEY"])
    r = client.models.generate_content(model="gemini-3.1-flash-lite", contents=PROMPT)
    return r.text


def test_langchain():
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(base_url=BASE_URL, api_key=API_KEY, model=MODEL)
    return llm.invoke(PROMPT).content


def test_llamaindex():
    from llama_index.llms.openai_like import OpenAILike

    llm = OpenAILike(api_base=BASE_URL, api_key=API_KEY, model=MODEL, is_chat_model=True)
    return llm.complete(PROMPT).text


def test_vllm():
    # vLLM serves an OpenAI-compatible API, so a client call looks the same as test_openai.
    # It only runs when you have a vLLM server (set VLLM_URL, e.g. http://localhost:8000/v1).
    from openai import OpenAI

    client = OpenAI(base_url=os.environ["VLLM_URL"], api_key="none")
    r = client.chat.completions.create(
        model=os.environ["VLLM_MODEL"], messages=[{"role": "user", "content": PROMPT}]
    )
    return r.choices[0].message.content


# name -> (function, env var that must be set to run it)
tests = {
    "openai": (test_openai, "GROQ_API_KEY"),
    "anthropic": (test_anthropic, "OPENROUTER_API_KEY"),
    "google": (test_google, "Gemini_API_KEY"),
    "langchain": (test_langchain, "GROQ_API_KEY"),
    "llamaindex": (test_llamaindex, "GROQ_API_KEY"),
    "vllm": (test_vllm, "VLLM_URL"),
}

for name, (function, needs) in tests.items():
    if not os.environ.get(needs):
        print(f"{name:12} SKIPPED (set {needs})")
        continue
    try:
        print(f"{name:12} OK: {function()!r}")
    except Exception as e:
        # Failed calls still produce an error span, which is also useful to see.
        print(f"{name:12} FAILED: {type(e).__name__}: {str(e)[:100]}")
