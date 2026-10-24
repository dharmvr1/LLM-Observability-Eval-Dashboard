// Small helpers for showing numbers, times and text.

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

export function usd(value: number): string {
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(2)}`;
}

/** ClickHouse gives "2026-10-23 12:18:16.165" in UTC; show it the same way every time. */
export function when(value: string): string {
  return value.slice(0, 19) + " UTC";
}

/**
 * The trace page shows prompts and answers, which can contain personal data.
 * Mask SSN-like numbers and long digit runs (cards, accounts) before they are shown.
 * This is display-only: the real text is still stored in ClickHouse.
 */
export function maskSensitive(text: string): string {
  return text
    .replace(/\b\d{3}[-. ]\d{2}[-. ]\d{4}\b/g, "###-##-####")
    .replace(/\b(?:\d[ -]?){12,}\d\b/g, "################");
}

/** The text of the last message with this role, from [{"role":..,"parts":[{"content":..}]}]. */
export function lastMessage(messagesJson: string, role: "user" | "assistant" | "system"): string {
  if (!messagesJson) return "";
  try {
    const messages = JSON.parse(messagesJson) as { role: string; parts?: { content?: string }[] }[];
    const wanted = messages.filter((m) => m.role === role);
    const last = wanted[wanted.length - 1];
    return (last?.parts ?? []).map((p) => p.content ?? "").join("\n");
  } catch {
    return messagesJson; // not JSON in the expected shape: show it as it is
  }
}

/** A rate in the unit that reads best: per second when busy, per minute or per hour when quiet. */
export function rate(count: number, seconds: number): string {
  const perSecond = count / seconds;
  if (perSecond >= 1) return `${perSecond.toFixed(1)} per second`;
  if (perSecond * 60 >= 1) return `${(perSecond * 60).toFixed(1)} per minute`;
  return `${(perSecond * 3600).toFixed(1)} per hour`;
}
