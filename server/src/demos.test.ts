import { describe, expect, it, vi } from "vitest";
import { demoInput, loadDemos, warmDemos } from "./demos.ts";

describe("demos", () => {
  it("loads three resolved demo profiles", () => {
    const demos = loadDemos();

    expect(demos.map((d) => d.id)).toEqual(["nyc-indie", "nyc-blend", "la-visit"]);
    expect(demos.every((d) => d.people.every((p) => p.picks.length >= 3 && p.picks.every((o) => o.id)))).toBe(true);
  });

  it("turns a demo into transplant input", () => {
    const input = demoInput(loadDemos().find((d) => d.id === "nyc-indie")!);

    expect(input).toMatchObject({ cityId: "nyc", mode: "moving" });
    expect(input.people[0]!.entities).toHaveLength(3);
    expect(input.people[0]!.tags).toHaveLength(1);
    expect(input.people[0]!.names).toHaveLength(4);
  });

  it("warms each demo through the pipeline without calling the LLM", async () => {
    const run = vi.fn(async (_input: { cityId: string }) => {});

    await warmDemos(loadDemos(), run, () => {});

    expect(run.mock.calls.map(([input]) => input.cityId)).toEqual(["nyc", "nyc", "la"]);
  });
});
