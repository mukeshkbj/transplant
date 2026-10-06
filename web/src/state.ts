import type { Chip, ChipOption, MapCell, Place, RankedHood, SharedTag, SignalStrength, Story, TransplantEvent, TransplantInput } from "./types.ts";

export type Mode = "moving" | "visiting";

export interface Person {
  label: string;
  text: string;
  chips: Chip[];
  resolving: boolean;
  error?: string;
}

export interface Step {
  id: string;
  label: string;
  status: "running" | "done";
}

export interface Results {
  hoods: RankedHood[];
  cells: MapCell[];
  signal: SignalStrength;
  shared?: SharedTag[];
  story?: Story;
  storySource?: "llm" | "template";
}

export interface State {
  cityId: string;
  mode: Mode;
  blend: boolean;
  people: Person[];
  stage: "intake" | "running" | "results";
  steps: Step[];
  results?: Results;
  placesByHood: Record<string, Place[]>;
  activeHoodId?: string;
  error?: { code: string; message: string };
}

export type Action =
  | { type: "city"; cityId: string }
  | { type: "mode"; mode: Mode }
  | { type: "blend"; on: boolean }
  | { type: "text"; person: number; text: string }
  | { type: "resolveStart"; person: number }
  | { type: "resolveDone"; person: number; chips: Chip[] }
  | { type: "resolveFail"; person: number; message: string }
  | { type: "pick"; person: number; chip: number; optionId: string }
  | { type: "removeChip"; person: number; chip: number }
  | { type: "runStart" }
  | { type: "event"; event: TransplantEvent }
  | { type: "runFail"; code: string; message: string }
  | { type: "selectHood"; hoodId: string }
  | { type: "hoodPlaces"; hoodId: string; places: Place[] }
  | { type: "restart" };

export const MIN_PICKS = 3;

const person = (label: string): Person => ({ label, text: "", chips: [], resolving: false });

export const initialState = (cityId = "nyc"): State => ({
  cityId,
  mode: "moving",
  blend: false,
  people: [person("You"), person("Them")],
  stage: "intake",
  steps: [],
  placesByHood: {},
});

const chipKey = (c: Chip) => c.selected?.id ?? c.query.toLowerCase();

const mergeChips = (current: Chip[], incoming: Chip[]) => {
  const seen = new Set(current.map(chipKey));
  return [...current, ...incoming.filter((c) => !seen.has(chipKey(c)) && seen.add(chipKey(c)))];
};

const updatePerson = (s: State, index: number, update: (p: Person) => Person): State => ({
  ...s,
  people: s.people.map((p, i) => (i === index ? update(p) : p)),
});

const cleared = { steps: [], results: undefined, placesByHood: {}, activeHoodId: undefined, error: undefined };

function applyEvent(s: State, e: TransplantEvent): State {
  switch (e.type) {
    case "step": {
      const step = { id: e.id, label: e.label, status: e.status };
      const exists = s.steps.some((x) => x.id === e.id);
      return { ...s, steps: exists ? s.steps.map((x) => (x.id === e.id ? step : x)) : [...s.steps, step] };
    }
    case "hoods":
      return { ...s, stage: "results", results: { hoods: e.hoods, cells: e.cells, signal: e.signal }, activeHoodId: e.hoods[0]?.id };
    case "shared":
      return s.results ? { ...s, results: { ...s.results, shared: e.tags } } : s;
    case "places":
      return { ...s, placesByHood: { ...s.placesByHood, [e.hoodId]: e.places } };
    case "story":
      return s.results ? { ...s, results: { ...s.results, story: e.story, storySource: e.source } } : s;
    case "error":
      return { ...s, stage: s.results ? "results" : "intake", error: { code: e.code, message: e.message } };
    case "done":
      return s;
  }
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "city":
      return { ...s, cityId: a.cityId };
    case "mode":
      return { ...s, mode: a.mode };
    case "blend":
      return { ...s, blend: a.on };
    case "text":
      return updatePerson(s, a.person, (p) => ({ ...p, text: a.text }));
    case "resolveStart":
      return updatePerson(s, a.person, (p) => ({ ...p, resolving: true, error: undefined }));
    case "resolveDone":
      return updatePerson(s, a.person, (p) => ({ ...p, resolving: false, chips: mergeChips(p.chips, a.chips) }));
    case "resolveFail":
      return updatePerson(s, a.person, (p) => ({ ...p, resolving: false, error: a.message }));
    case "pick":
      return updatePerson(s, a.person, (p) => ({
        ...p,
        chips: p.chips.map((c, i) => {
          const selected = i === a.chip ? c.options.find((o) => o.id === a.optionId) : undefined;
          return selected ? { ...c, status: "resolved", selected } : c;
        }),
      }));
    case "removeChip":
      return updatePerson(s, a.person, (p) => ({ ...p, chips: p.chips.filter((_, i) => i !== a.chip) }));
    case "runStart":
      return { ...s, ...cleared, stage: "running" };
    case "event":
      return applyEvent(s, a.event);
    case "runFail":
      return { ...s, stage: s.results ? "results" : "intake", error: { code: a.code, message: a.message } };
    case "selectHood":
      return { ...s, activeHoodId: a.hoodId };
    case "hoodPlaces":
      return { ...s, placesByHood: { ...s.placesByHood, [a.hoodId]: a.places } };
    case "restart":
      return { ...s, ...cleared, stage: "intake" };
  }
}

export const confirmed = (p: Person): ChipOption[] => p.chips.flatMap((c) => (c.status === "resolved" && c.selected ? [c.selected] : []));

export function toInput(s: State): TransplantInput {
  const people = (s.blend ? s.people : s.people.slice(0, 1)).map((p) => {
    const picks = confirmed(p);
    return {
      label: p.label,
      names: picks.map((o) => o.name).slice(0, 15),
      entities: picks
        .filter((o) => o.kind === "entity")
        .map((o) => o.id)
        .slice(0, 10),
      tags: picks
        .filter((o) => o.kind === "concept")
        .map((o) => o.id)
        .slice(0, 5),
    };
  });
  return { cityId: s.cityId, mode: s.mode, people };
}

export const readyToRun = (s: State) => toInput(s).people.every((p) => p.entities.length + p.tags.length >= MIN_PICKS);
