import { useState } from "react";
import type { State } from "../state.ts";

const QUICK = ["Quieter", "More nightlife", "Great coffee", "Good for kids"];

interface Props {
  hoodName: string;
  guide: State["guide"];
  onAsk: (text: string) => void;
}

export function Guide({ hoodName, guide, onAsk }: Props) {
  const [text, setText] = useState("");
  const ask = (value: string) => {
    if (!value.trim() || guide.busy) return;
    onAsk(value.trim());
    setText("");
  };
  return (
    <section className="guide" aria-label="Your local guide">
      <h2 className="section-title">Ask your guide</h2>
      <p className="provenance mono">An AI agent that refines {hoodName} using live Qloo tags and places.</p>
      <div className="guide__quick">
        {QUICK.map((q) => (
          <button key={q} type="button" className="stamp__option" disabled={guide.busy} onClick={() => ask(q)}>
            {q}
          </button>
        ))}
      </div>
      <ol className="guide__turns" aria-live="polite">
        {guide.turns.map((turn, i) => (
          <li key={i} className={`guide__turn guide__turn--${turn.role}`}>
            <p>{turn.text}</p>
            {turn.trace && turn.trace.length > 0 && (
              <ul className="guide__trace mono">
                {turn.trace.map((step, j) => (
                  <li key={j}>↳ {step.summary}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {guide.busy && (
          <li className="guide__turn guide__turn--guide mono" aria-busy="true">
            Checking Qloo…
          </li>
        )}
      </ol>
      <form
        className="guide__form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <label className="eyebrow" htmlFor="guide-input">
          Ask your guide
        </label>
        <input id="guide-input" value={text} maxLength={300} placeholder="e.g. somewhere for brunch" onChange={(e) => setText(e.target.value)} />
      </form>
    </section>
  );
}
