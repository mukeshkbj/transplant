import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chip, TransplantEvent } from "./types.ts";

const api = vi.hoisted(() => ({
  fetchCities: vi.fn(),
  resolveTaste: vi.fn(),
  streamTransplant: vi.fn(),
  fetchPlaces: vi.fn(),
}));
vi.mock("./api.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
vi.mock("./components/MapView.tsx", () => ({ MapView: () => <div data-testid="map" /> }));

const { App } = await import("./App.tsx");

const chip = (name: string, type: string): Chip => ({
  query: name,
  kind: "entity",
  status: "resolved",
  selected: { id: name, name, type, kind: "entity" },
  options: [],
});

const events: TransplantEvent[] = [
  { type: "step", id: "map", label: "Mapping where your taste lives in New York City", status: "running" },
  {
    type: "hoods",
    hoods: [{ id: "h1", name: "Greenpoint", lat: 40.73, lng: -73.95, score: 0.037, cellCount: 13, byType: [{}], perPerson: [0.037] }],
    cells: [],
    signal: { level: "strong", topScore: 0.037, cells: 13 },
  },
  {
    type: "places",
    hoodId: "h1",
    places: [{ id: "p1", name: "Desert Island", genre: "", categories: ["Book store"], lat: 0, lng: 0, affinity: 0.85, closed: false }],
  },
  {
    type: "story",
    source: "llm",
    story: { hoods: [{ hoodId: "h1", headline: "Crate-digger's corner", why: "w" }], plan: [{ when: "Day 1", placeId: "p1", note: "Zines" }] },
  },
  { type: "done" },
];

beforeEach(() => {
  api.fetchCities.mockResolvedValue([
    { id: "nyc", name: "New York City", beta: false, bbox: [40.49, -74.26, 40.92, -73.7] },
    { id: "tokyo", name: "Tokyo", beta: true, bbox: [35.53, 139.56, 35.82, 139.92] },
  ]);
  api.resolveTaste.mockResolvedValue([chip("Khruangbin", "artist"), chip("Fleabag", "tv_show"), chip("Aesop", "brand")]);
  api.streamTransplant.mockImplementation(async (_input: unknown, onEvent: (e: TransplantEvent) => void) => {
    for (const e of events) onEvent(e);
  });
});

describe("App", () => {
  it("goes from taste text to stamped picks to a mapped result", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /tokyo\s*beta/i })).toBeTruthy();

    const run = screen.getByRole("button", { name: /transplant my taste/i });
    expect((run as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText(/what do you love/i), "Khruangbin, Fleabag, Aesop");
    await userEvent.click(screen.getByRole("button", { name: /read my taste/i }));
    expect(await screen.findByText(/3\/3 stamps/i)).toBeTruthy();
    expect(api.resolveTaste).toHaveBeenCalledWith("Khruangbin, Fleabag, Aesop");

    await userEvent.click(run);

    const visa = await screen.findByLabelText(/taste visa/i);
    expect(within(visa).getByText("Greenpoint")).toBeTruthy();
    expect(screen.getByText("Crate-digger's corner")).toBeTruthy();
    expect(screen.getAllByText("Desert Island").length).toBeGreaterThan(0);
    expect(api.streamTransplant.mock.calls[0]![0]).toMatchObject({ cityId: "nyc", people: [{ entities: ["Khruangbin", "Fleabag", "Aesop"] }] });
  });

  it("shows a friendly error and returns to intake when the run fails early", async () => {
    api.streamTransplant.mockImplementation(async (_input: unknown, onEvent: (e: TransplantEvent) => void) => {
      onEvent({ type: "error", code: "NO_SIGNAL", message: "Not enough Qloo taste signal in New York City." });
    });
    render(<App />);
    await userEvent.type(await screen.findByLabelText(/what do you love/i), "a, b, c");
    await userEvent.click(screen.getByRole("button", { name: /read my taste/i }));
    await userEvent.click(await screen.findByRole("button", { name: /transplant my taste/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/not enough qloo taste signal/i);
    expect(screen.getByLabelText(/what do you love/i)).toBeTruthy();
  });
});
