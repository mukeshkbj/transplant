import type { Dispatch } from "react";
import { type Action, readyToRun, type State } from "../state.ts";
import type { CityInfo, Demo } from "../types.ts";
import { stagger } from "../ui.ts";
import { ChipBoard } from "./ChipBoard.tsx";

const EXAMPLES = [
  "Khruangbin, Fleabag, natural wine bars and Aesop",
  "Phoebe Bridgers, Severance, vintage clothing and Spirited Away",
  "Metallica, Top Gun: Maverick, Harley-Davidson and steakhouses",
];

interface Props {
  state: State;
  cities: CityInfo[];
  demos: Demo[];
  dispatch: Dispatch<Action>;
  onRead: (person: number) => void;
  onRun: () => void;
  onDemo: (demo: Demo) => void;
}

function TasteInput({ state, index, dispatch, onRead }: { state: State; index: number; dispatch: Dispatch<Action>; onRead: (person: number) => void }) {
  const person = state.people[index]!;
  return (
    <div className="ticket__section">
      <form
        className="taste"
        onSubmit={(e) => {
          e.preventDefault();
          onRead(index);
        }}
      >
        <label className="eyebrow" htmlFor={`taste-${index}`}>
          {index === 0 ? "What do you love?" : "What do they love?"}
        </label>
        <textarea
          id={`taste-${index}`}
          rows={3}
          maxLength={600}
          value={person.text}
          placeholder="Artists, shows, films, brands, the kind of places you seek out…"
          onChange={(e) => dispatch({ type: "text", person: index, text: e.target.value })}
        />
        <div className="taste__row">
          <button type="submit" className="btn btn--ink" disabled={!person.text.trim() || person.resolving}>
            {person.resolving ? "Reading your taste…" : "Read my taste"}
          </button>
          {index === 0 &&
            EXAMPLES.slice(0, 2).map((example) => (
              <button key={example} type="button" className="link" onClick={() => dispatch({ type: "text", person: 0, text: example })}>
                e.g. {example.split(",")[0]}…
              </button>
            ))}
          {index === 1 && (
            <button type="button" className="link" onClick={() => dispatch({ type: "text", person: 1, text: EXAMPLES[2]! })}>
              e.g. {EXAMPLES[2]!.split(",")[0]}…
            </button>
          )}
        </div>
        {person.error && (
          <p role="alert" className="error">
            {person.error}
          </p>
        )}
      </form>
      <ChipBoard person={person} index={index} dispatch={dispatch} />
    </div>
  );
}

export function Intake({ state, cities, demos, dispatch, onRead, onRun, onDemo }: Props) {
  const ready = readyToRun(state);
  return (
    <main className="cover">
      <section className="reveal">
        <p className="eyebrow">Vol. 1 · {cities.length || 12} cities · powered by Qloo's taste graph</p>
        <h2 className="cover__headline">Find the neighborhood that already loves what you love.</h2>
        <p className="cover__dek">
          Tell us your artists, shows, brands and haunts. We map where people with your exact taste cluster in a new city — then hand you the
          spots and your first week.
        </p>
        {demos.length > 0 && (
          <div className="ticket__section">
            <p className="eyebrow">Or try a ready-made taste</p>
            <ul className="demos">
              {demos.map((d) => (
                <li key={d.id}>
                  <button type="button" className="demo" onClick={() => onDemo(d)}>
                    <strong>{d.title}</strong>
                    <span className="mono">{d.blurb}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="ticket reveal" style={stagger(1)}>
        <div className="ticket__section">
          <p className="eyebrow">Destination</p>
          <ul className="destinations">
            {cities.map((c) => (
              <li key={c.id}>
                <button type="button" className="destination" aria-pressed={c.id === state.cityId} onClick={() => dispatch({ type: "city", cityId: c.id })}>
                  {c.name}
                  {c.beta && <span className="destination__beta">beta</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="segmented" role="group" aria-label="Trip type">
            {(["moving", "visiting"] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={state.mode === mode} onClick={() => dispatch({ type: "mode", mode })}>
                {mode === "moving" ? "Moving there" : "Visiting"}
              </button>
            ))}
          </div>
        </div>

        <TasteInput state={state} index={0} dispatch={dispatch} onRead={onRead} />

        <label className="blend-toggle">
          <input type="checkbox" checked={state.blend} onChange={(e) => dispatch({ type: "blend", on: e.target.checked })} />
          Moving with someone? Blend your tastes
        </label>
        {state.blend && <TasteInput state={state} index={1} dispatch={dispatch} onRead={onRead} />}

        <div>
          <button type="button" className="btn btn--stamp" disabled={!ready} onClick={onRun}>
            Transplant my taste →
          </button>
          {!ready && <p className="stamps__count mono">Confirm at least 3 stamps{state.blend ? " each" : ""} to board.</p>}
        </div>
      </section>
    </main>
  );
}
