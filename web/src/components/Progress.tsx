import type { Step } from "../state.ts";

export function Progress({ steps, cityName }: { steps: Step[]; cityName: string }) {
  return (
    <main className="boarding" aria-live="polite">
      <p className="eyebrow">Now boarding · {cityName}</p>
      <ol>
        {steps.length === 0 && (
          <li data-status="running">
            <span className="mono">…</span>Checking in your taste
          </li>
        )}
        {steps.map((s) => (
          <li key={s.id} data-status={s.status}>
            <span className="mono">{s.status === "done" ? "✓" : "…"}</span>
            {s.label}
          </li>
        ))}
      </ol>
    </main>
  );
}
