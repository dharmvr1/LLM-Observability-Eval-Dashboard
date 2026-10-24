// PLACEHOLDER PRICES in US dollars per 1 million tokens. They are NOT real price lists:
// every model we use runs on a free tier, so there is no bill. Edit these to your own prices
// to see the cost per user the way a paid setup would show it.
type Price = { input: number; output: number };

const PRICES: { match: string; price: Price }[] = [
  { match: ":free", price: { input: 0, output: 0 } },
  { match: "gpt-oss-120b", price: { input: 0.15, output: 0.6 } },
  { match: "gpt-oss-20b", price: { input: 0.1, output: 0.5 } },
  { match: "gemini", price: { input: 0.1, output: 0.4 } },
  { match: "synthetic", price: { input: 0, output: 0 } },
];
const DEFAULT_PRICE: Price = { input: 0.5, output: 1.5 }; // any model not listed above

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const lower = model.toLowerCase();
  const price = PRICES.find((p) => lower.includes(p.match))?.price ?? DEFAULT_PRICE;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
