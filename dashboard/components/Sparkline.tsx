// A tiny trend line. The whole line is de-emphasised; the latest stretch and the end dot carry the accent.
// Plain SVG computed on the server, so it needs no JavaScript in the browser.
export default function Sparkline({ values, width = 130, height = 34 }: { values: number[]; width?: number; height?: number }) {
  const clean = values.filter((v) => Number.isFinite(v));
  // Fewer than four points draw a misleading straight line, so show nothing.
  if (clean.length < 4) return null;
  const pad = 4;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (clean.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const points = clean.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const tail = points.slice(-3).join(" ");
  const last = clean.length - 1;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Trend over ${clean.length} points, latest ${clean[last]}`}>
      <polyline points={points.join(" ")} fill="none" stroke="var(--axis)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points={tail} fill="none" stroke="var(--s1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(last)} cy={y(clean[last])} r="4" fill="var(--s1)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}
