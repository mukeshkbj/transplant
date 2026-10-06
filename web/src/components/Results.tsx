import { lazy, Suspense } from "react";
import { placeLabel } from "../../../server/src/places.ts";
import { type State, toInput } from "../state.ts";
import type { CityInfo, Place, RankedHood } from "../types.ts";
import { stagger } from "../ui.ts";
import { Guide } from "./Guide.tsx";

const MapView = lazy(async () => ({ default: (await import("./MapView.tsx")).MapView }));

interface Props {
  state: State;
  city: CityInfo;
  onSelectHood: (hoodId: string) => void;
  onRestart: () => void;
  onAsk: (text: string) => void;
}

const lift = (score: number) => `+${(score * 100).toFixed(1)}`;

function Meter({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(...values.map(Math.abs), Number.EPSILON);
  return (
    <div className="meter mono" aria-label="Fit for each person">
      {values.map((v, i) => (
        <div className="meter__row" key={labels[i]}>
          <span>{labels[i]}</span>
          <span className="meter__bar" style={{ transform: `scaleX(${Math.max(v, 0) / max})` }} />
        </div>
      ))}
    </div>
  );
}

function Places({ places, hoodName, filters }: { places: Place[] | undefined; hoodName: string; filters?: string[] }) {
  return (
    <section className="reveal" style={stagger(3)}>
      <h2 className="section-title">Your spots in {hoodName}</h2>
      {filters && filters.length > 0 && <p className="mono">Filtered by Qloo tags: {filters.join(", ")}</p>}
      {!places && <p className="mono">Finding spots in {hoodName}…</p>}
      {places?.length === 0 && <p>No curated spots here yet.</p>}
      <ul className="places">
        {places?.map((p) => (
          <li key={p.id} className="place">
            {p.image ? <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="place__ph" />}
            <div>
              <span className="mono">{placeLabel(p)}</span>
              <strong>{p.name}</strong>
              {p.address && <span className="place__addr">{p.address}</span>}
            </div>
            <span className="badge">Qloo match {Math.round(p.affinity * 100)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Results({ state, city, onSelectHood, onRestart, onAsk }: Props) {
  const results = state.results!;
  const [top] = results.hoods as [RankedHood, ...RankedHood[]];
  const active = results.hoods.find((h) => h.id === state.activeHoodId) ?? top;
  const labels = toInput(state).people.map((p) => p.label);
  const topPlaces = state.placesByHood[top.id] ?? [];
  const byId = new Map(topPlaces.map((p) => [p.id, p]));
  const { story, storySource } = results;

  return (
    <main className="results">
      <div className="results__column">
        <p className="signal mono" data-level={results.signal.level}>
          Signal {results.signal.level}
          {city.beta ? " · beta city" : ""}
        </p>

        <aside className="visa reveal" aria-label="Your taste visa">
          <div className="visa__head mono">
            <span>Taste visa</span>
            <span>{city.name}</span>
          </div>
          <p className="visa__hood">{top.name}</p>
          <p className="mono">
            {state.mode === "moving" ? "Residency" : "Visit"} · holder{labels.length > 1 ? "s" : ""}: {labels.join(" & ")}
          </p>
          <div className="visa__stamp" aria-hidden>
            Admitted
          </div>
        </aside>

        {results.shared && results.shared.length > 0 && (
          <section>
            <p className="eyebrow">What you both love</p>
            <ul className="shared">
              {results.shared.map((t) => (
                <li key={t.id} className="badge">
                  {t.name}
                </li>
              ))}
            </ul>
          </section>
        )}

        <ol className="hoods">
          {results.hoods.map((hood, i) => {
            const copy = story?.hoods.find((h) => h.hoodId === hood.id);
            return (
              <li key={hood.id} className="reveal" style={stagger(i + 1)}>
                <article className="hood" data-active={hood.id === active.id}>
                  <span className="mono">No. {i + 1}</span>
                  <h3 className="hood__name">
                    <button type="button" aria-pressed={hood.id === active.id} onClick={() => onSelectHood(hood.id)}>
                      {hood.name}
                    </button>
                  </h3>
                  {copy ? <p className="hood__headline">{copy.headline}</p> : <p className="hood__headline skeleton" aria-hidden />}
                  {copy && <p className="hood__why">{copy.why}</p>}
                  <dl className="hood__facts mono">
                    <div>
                      <dt>Taste lift</dt>
                      <dd>{lift(hood.score)}</dd>
                    </div>
                    <div>
                      <dt>Evidence</dt>
                      <dd>{hood.cellCount} Qloo cells</dd>
                    </div>
                  </dl>
                  {hood.perPerson.length > 1 && <Meter values={hood.perPerson} labels={labels} />}
                </article>
              </li>
            );
          })}
        </ol>

        <Places places={state.placesByHood[active.id]} hoodName={active.name} filters={state.placeFilters[active.id]} />

        <Guide hoodName={active.name} guide={state.guide} onAsk={onAsk} />

        {story && story.plan.length > 0 && (
          <section className="reveal" style={stagger(4)}>
            <h2 className="section-title">{state.mode === "moving" ? `Your first week in ${top.name}` : `Your days in ${top.name}`}</h2>
            <ol className="plan">
              {story.plan.map((item) => {
                const place = byId.get(item.placeId);
                return place ? (
                  <li key={`${item.when}-${item.placeId}`}>
                    <span className="mono">{item.when}</span>
                    <span className="plan__place">{place.name}</span>
                    <span className="plan__note">{item.note}</span>
                  </li>
                ) : null;
              })}
            </ol>
            <p className="provenance mono">{storySource === "llm" ? "Written by AI from Qloo evidence" : "Summarized from Qloo evidence"}</p>
          </section>
        )}

        <button type="button" className="btn" onClick={onRestart}>
          ← Try another taste or city
        </button>
      </div>

      <div className="results__map">
        <Suspense fallback={<div className="map" />}>
          <MapView city={city} cells={results.cells} hoods={results.hoods} activeHoodId={active.id} onSelectHood={onSelectHood} />
        </Suspense>
      </div>
    </main>
  );
}
