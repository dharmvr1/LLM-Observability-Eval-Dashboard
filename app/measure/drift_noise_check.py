# How noisy is PSI when NOTHING changed? Run this before trusting the drift threshold.
#   python -m app.measure.drift_noise_check [app_id]        (default: drift-demo-stable)
# It shuffles one app's prompts many times into a fake "baseline" and a fake "current" window of the
# real sizes, and prints how often PSI is above 0.2 by chance, for 3, 5 and 10 bins. If the share is
# more than a few percent, the threshold or the number of bins is wrong for your sample size.
import sys

import numpy as np

app = sys.argv[1] if len(sys.argv) > 1 else "drift-demo-stable"
sys.argv = ["x"]
from app.jobs.drift_job import BASELINE_DAYS, CURRENT_DAYS, PSI_THRESHOLD, db, last_user_text, model  # noqa: E402

rng = np.random.default_rng(0)


def psi_with_bins(base, cur, bins):
    edges = np.quantile(base, np.linspace(0, 1, bins + 1)[1:-1])
    b = np.maximum(np.bincount(np.digitize(base, edges), minlength=bins) / len(base), 1e-4)
    c = np.maximum(np.bincount(np.digitize(cur, edges), minlength=bins) / len(cur), 1e-4)
    return float(np.sum((c - b) * np.log(c / b)))


boundary = db.query(f"SELECT now() - INTERVAL {CURRENT_DAYS} DAY").result_rows[0][0]
rows = db.query(
    "SELECT start_time, attributes['gen_ai.input.messages'] FROM otel.spans WHERE app_id = {a:String}",
    parameters={"a": app},
).result_rows
baseline_texts = [last_user_text(m) for t, m in rows if t < boundary]
current_texts = [last_user_text(m) for t, m in rows if t >= boundary]
baseline_vectors = model.encode(baseline_texts, normalize_embeddings=True, batch_size=64)
centroid = baseline_vectors.mean(axis=0)
centroid = centroid / np.linalg.norm(centroid)
scores = baseline_vectors @ centroid  # one number per baseline prompt
n_current = len(current_texts)
print(f"{app}: {len(baseline_texts)} baseline prompts, {n_current} current prompts")

for bins in (3, 5, 10):
    values = []
    for _ in range(500):
        order = rng.permutation(len(scores))
        values.append(psi_with_bins(scores[order[n_current:]], scores[order[:n_current]], bins))
    values = np.array(values)
    print(f"bins={bins:2}  typical PSI with no drift: mean={values.mean():.3f} p95={np.quantile(values, .95):.3f}  "
          f"share above {PSI_THRESHOLD}: {(values > PSI_THRESHOLD).mean():.1%}")
