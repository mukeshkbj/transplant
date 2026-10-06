import { useEffect, useReducer, useRef, useState } from "react";
import { ApiError, fetchCities, fetchDemos, fetchHealth, fetchPlaces, refine, resolveTaste, streamTransplant } from "./api.ts";
import { Intake } from "./components/Intake.tsx";
import { Progress } from "./components/Progress.tsx";
import { Results } from "./components/Results.tsx";
import { decodeShare, encodeShare, type PicksPayload } from "./share.ts";
import { type Action, initialState, reducer, type State, toInput, toPicks } from "./state.ts";
import type { CityInfo, Demo } from "./types.ts";

const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState());
  const [cities, setCities] = useState<CityInfo[]>([]);
  const [demos, setDemos] = useState<Demo[]>([]);
  const [lowQuota, setLowQuota] = useState(false);
  const autoRan = useRef(false);
  const city = cities.find((c) => c.id === state.cityId);

  useEffect(() => {
    fetchCities()
      .then(setCities)
      .catch(() => setCities([]));
    fetchDemos()
      .then(setDemos)
      .catch(() => setDemos([]));
    fetchHealth()
      .then((h) => setLowQuota(h.qlooMonthRemaining !== null && h.qlooMonthRemaining < h.quotaFloor * 2))
      .catch(() => {});
  }, []);

  const read = async (person: number) => {
    dispatch({ type: "resolveStart", person });
    try {
      dispatch({ type: "resolveDone", person, chips: await resolveTaste(state.people[person]!.text) });
    } catch (error) {
      dispatch({ type: "resolveFail", person, message: message(error, "Couldn't read that. Try again.") });
    }
  };

  const run = async (s: State = state) => {
    dispatch({ type: "runStart" });
    try {
      await streamTransplant(toInput(s), (event) => dispatch({ type: "event", event }));
    } catch (error) {
      dispatch({ type: "runFail", code: error instanceof ApiError ? error.code : "NETWORK", message: message(error, "Connection lost. Try again.") });
    }
  };

  const startPicks = (payload: PicksPayload, demoId?: string) => {
    const action: Action = { type: "loadPicks", payload, demoId };
    const next = reducer(state, action);
    dispatch(action);
    void run(next);
  };

  const onDemo = (demo: Demo) => startPicks({ cityId: demo.cityId, mode: demo.mode, people: demo.people }, demo.id);

  useEffect(() => {
    if (autoRan.current || cities.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const demoId = params.get("demo");
    const token = params.get("t");
    if (demoId && demos.length === 0) return;
    autoRan.current = true;
    const demo = demos.find((d) => d.id === demoId);
    if (demo) return onDemo(demo);
    const shared = token ? decodeShare(token) : undefined;
    if (shared && cities.some((c) => c.id === shared.cityId)) startPicks(shared);
  });

  const shareUrl = `${window.location.origin}/?${state.demoId ? `demo=${state.demoId}` : `t=${encodeShare(toPicks(state))}`}`;

  const selectHood = async (hoodId: string) => {
    dispatch({ type: "selectHood", hoodId });
    if (state.placesByHood[hoodId]) return;
    const places = await fetchPlaces(toInput(state), hoodId).catch(() => []);
    dispatch({ type: "hoodPlaces", hoodId, places });
  };

  const ask = async (text: string) => {
    if (!state.results || !state.activeHoodId) return;
    dispatch({ type: "guideAsk", text });
    try {
      const result = await refine({
        cityId: state.cityId,
        people: toInput(state).people,
        hoods: state.results.hoods.map(({ id, name }) => ({ id, name })),
        activeHoodId: state.activeHoodId,
        message: text,
      });
      dispatch({ type: "guideReply", reply: result.reply, trace: result.trace });
      for (const action of result.actions) {
        dispatch(
          action.type === "places"
            ? { type: "hoodPlaces", hoodId: action.hoodId, places: action.places, filters: action.filters }
            : { type: "selectHood", hoodId: action.hoodId },
        );
      }
    } catch (error) {
      dispatch({ type: "guideFail", message: message(error, "The guide is busy. Try again in a moment.") });
    }
  };

  const restart = () => dispatch({ type: "restart" });

  return (
    <div className="app" data-stage={state.stage}>
      <header className="masthead">
        <h1 className="masthead__title">
          <button type="button" onClick={restart}>
            Transplant
          </button>
        </h1>
        <span className="masthead__issue mono">A field guide to where your taste lives</span>
      </header>

      {lowQuota && <p className="banner">Live Qloo lookups are running low — the ready-made tastes always work.</p>}
      {state.error && (
        <p role="alert" className="banner">
          {state.error.message}
        </p>
      )}

      {state.stage === "intake" && (
        <Intake state={state} cities={cities} demos={demos} dispatch={dispatch} onRead={read} onRun={() => void run()} onDemo={onDemo} />
      )}
      {state.stage === "running" && <Progress steps={state.steps} cityName={city?.name ?? ""} />}
      {state.stage === "results" && city && state.results && (
        <Results state={state} city={city} onSelectHood={selectHood} onRestart={restart} onAsk={ask} shareUrl={shareUrl} />
      )}

      <footer className="colophon mono">
        Taste data: Qloo. Results are aggregate cultural affinities, not predictions about any person. Neighborhoods © OpenStreetMap
        contributors. Map tiles: OpenFreeMap.
      </footer>
    </div>
  );
}
