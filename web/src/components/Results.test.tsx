import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { initialState, type State } from "../state.ts";
import type { CityInfo, Place } from "../types.ts";
import { Results } from "./Results.tsx";

vi.mock("./MapView.tsx", () => ({ MapView: () => <div data-testid="map" /> }));

const city: CityInfo = { id: "nyc", name: "New York City", beta: false, bbox: [40.49, -74.26, 40.92, -73.7] };
const hood = (id: string, name: string) => ({ id, name, lat: 40.7, lng: -73.9, score: 0.037, cellCount: 13, byType: [{ artist: 0.9 }], perPerson: [0.037] });
const place = (id: string, name: string): Place =>
  ({ id, name, genre: "urn:tag:genre:place:comic_book_store", categories: [], lat: 0, lng: 0, affinity: 0.85, closed: false }) as Place;

const state: State = {
  ...initialState(),
  stage: "results",
  activeHoodId: "h1",
  results: {
    hoods: [hood("h1", "Greenpoint"), hood("h2", "Williamsburg")],
    cells: [],
    signal: { level: "strong", topScore: 0.037, cells: 13 },
    story: {
      hoods: [{ hoodId: "h1", headline: "Your crate-digging corner", why: "People who love Khruangbin over-index here." }],
      plan: [{ when: "Day 1", placeId: "p1", note: "Zines at Desert Island" }],
    },
    storySource: "llm",
  },
  placesByHood: { h1: [place("p1", "Desert Island")] },
};

describe("Results", () => {
  it("renders the visa, features, spots, plan, and provenance", () => {
    render(<Results state={state} city={city} onSelectHood={vi.fn()} onRestart={vi.fn()} onAsk={vi.fn()} />);

    expect(screen.getByLabelText(/taste visa/i).textContent).toMatch(/Greenpoint/);
    expect(screen.getByRole("heading", { name: "Williamsburg" })).toBeTruthy();
    expect(screen.getByText("Your crate-digging corner")).toBeTruthy();
    expect(screen.getByText("Comic book store")).toBeTruthy();
    expect(screen.getByText("Zines at Desert Island")).toBeTruthy();
    expect(screen.getByText(/written by ai from qloo evidence/i)).toBeTruthy();
    expect(screen.getByText(/signal strong/i)).toBeTruthy();
  });

  it("selects another hood", async () => {
    const onSelectHood = vi.fn();
    render(<Results state={state} city={city} onSelectHood={onSelectHood} onRestart={vi.fn()} onAsk={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /williamsburg/i }));

    expect(onSelectHood).toHaveBeenCalledWith("h2");
  });
});
