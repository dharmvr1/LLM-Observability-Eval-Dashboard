// Same default as the Python side (app/lib/usage.py): tokens a judge model may use per 24 hours.
export const DAILY_TOKEN_BUDGET = Number(process.env.JUDGE_DAILY_TOKEN_BUDGET ?? 150000);
