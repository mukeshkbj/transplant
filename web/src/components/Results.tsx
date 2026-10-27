import { lazy, Suspense, useState } from "react";
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
  shareUrl: string;
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

function Thumb({ src, label, n }: { src?: string; label: string; n: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="place__thumb">
      {!src || failed ? (
        <span className="place__ph" aria-hidden>
          {label.charAt(0)}
        </span>
      ) : (
        <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      )}
      <span className="place__n mono" aria-hidden>
        {n}
      </span>
    </span>
  );
}

const TASTE_LABELS: Record<string, string> = { artist: "Music", tv_show: "TV", movie: "Film", brand: "Brands", book: "Books", podcast: "Podcasts", place: "Venues" };

/** Per-type Qloo affinity for this neighborhood: what drove the match, and which tastes have no signal here. */
function TasteBars({ byType, types }: { byType: Record<string, number>; types: string[] }) {
  const rows = types.filter((t) => t in TASTE_LABELS);
  if (rows.length === 0) return null;
  return (
    <div className="tastebars mono" aria-label="Qloo affinity by taste type">
      {rows.map((t) => {
        const v = byType[t] ?? 0;
        return (
          <div className="tastebars__row" key={t} data-empty={v <= 0}>
            <span>{TASTE_LABELS[t]}</span>
            <span className="tastebars__track">
              <span className="tastebars__fill" style={{ transform: `scaleX(${Math.min(1, Math.max(v, 0))})` }} />
            </span>
            <span>{v > 0 ? Math.round(v * 100) : "no signal"}</span>
          </div>
        );
      })}
    </div>
  );
}

function Places({ places, hoodName, filters }: { places: Place[] | undefined; hoodName: string; filters?: string[] }) {
  return (
    <section className="reveal" style={stagger(3)}>
      <h2 className="section-title">Your spots in {hoodName}</h2>
      <p className="section-dek">Places within about a kilometre that people with your taste go to. The numbers match the map.</p>
      {filters && filters.length > 0 && <p className="filters mono">Filtered by Qloo tags: {filters.join(", ")}</p>}
      {!places && <p className="mono">Finding spots in {hoodName}…</p>}
      {places?.length === 0 && <p>No curated spots here yet.</p>}
      <ul className="places">
        {places?.map((p, i) => (
          <li key={p.id} className="place">
            <Thumb src={p.image} label={placeLabel(p)} n={i + 1} />
            <div>
              <span className="mono">{placeLabel(p)}</span>
              <strong>{p.name}</strong>
              {p.address && <span className="place__addr">{p.address}</span>}
            </div>
            <span className="place__meta mono">
              {p.neighborhood && <span>{p.neighborhood}</span>}
              {p.rating ? <span>★ {p.rating.toFixed(1)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Results({ state, city, onSelectHood, onRestart, onAsk, shareUrl }: Props) {
  const [copied, setCopied] = useState(false);
  const results = state.results!;
  const [top] = results.hoods as [RankedHood, ...RankedHood[]];
  const active = results.hoods.find((h) => h.id === state.activeHoodId) ?? top;
  const input = toInput(state);
  const labels = input.people.map((p) => p.label);
  const loveTypes = [...new Set((input.people[0]?.loves ?? []).map((l) => l.type))];
  const topPlaces = results.storyPlaces ?? state.placesByHood[top.id] ?? [];
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
                  {hood.perPerson.length > 1 ? <Meter values={hood.perPerson} labels={labels} /> : <TasteBars byType={hood.byType[0] ?? {}} types={loveTypes} />}
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
            <p className="provenance mono">{storySource === "llm" ? "Written with AI, using only places Qloo returned" : "Put together from Qloo data"}</p>
          </section>
        )}

        <div className="taste__row">
          <button type="button" className="btn" onClick={onRestart}>
            ← Try another taste or city
          </button>
          <button
            type="button"
            className="btn btn--ink"
            onClick={() => {
              void navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true));
            }}
          >
            {copied ? "Link copied" : "Copy share link"}
          </button>
        </div>
      </div>

      <div className="results__map">
        <Suspense fallback={<div className="map" />}>
          <MapView
            city={city}
            cells={results.cells}
            hoods={results.hoods}
            activeHoodId={active.id}
            onSelectHood={onSelectHood}
            places={state.placesByHood[active.id]}
          />
        </Suspense>
      </div>
    </main>
  );
}
