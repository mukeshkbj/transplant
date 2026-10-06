import { describe, expect, it } from "vitest";
import { fakeLlm, fakeQloo, fixture } from "../test/fakes.ts";
import { resolveTaste } from "./resolve.ts";

const qloo = fakeQloo((path, params) => {
  if (path === "/v2/tags") return fixture("tags-natural-wine-bars.json");
  if (params.query === "Aesop") return fixture("search-aesop-brand.json");
  if (params.query === "Lost")
    return {
      results: [
        { entity_id: "1", name: "Lost (2004)", types: ["urn:entity:tv_show"] },
        { entity_id: "2", name: "Lost Girl", types: ["urn:entity:tv_show"] },
      ],
    };
  if (params.query === "Zzyzx") return { results: [] };
  return undefined;
});

const llm = fakeLlm(() => ({
  items: [
    { query: "Aesop", kind: "entity", type: "brand" },
    { query: "natural wine bars", kind: "concept", type: "place" },
    { query: "Lost", kind: "entity", type: "tv_show" },
    { query: "Zzyzx", kind: "entity", type: "artist" },
  ],
}));

describe("resolveTaste", () => {
  it("builds resolved, concept, ambiguous, and missing chips", async () => {
    const chips = await resolveTaste("Aesop, natural wine bars, Lost, Zzyzx", { qloo: qloo.client, llm: llm.llm });

    expect(chips.map((c) => [c.query, c.kind, c.status])).toEqual([
      ["Aesop", "entity", "resolved"],
      ["natural wine bars", "concept", "resolved"],
      ["Lost", "entity", "ambiguous"],
      ["Zzyzx", "entity", "missing"],
    ]);
    expect(chips[0]!.selected).toMatchObject({ name: "Aesop", type: "brand", kind: "entity" });
    expect(chips[1]!.selected!.id).toMatch(/^urn:tag:/);
    expect(chips[2]!.options).toHaveLength(2);
    expect(chips[2]!.selected).toBeUndefined();
  });

  it("sends the user's text only to the LLM, and only extracted names to Qloo", async () => {
    await resolveTaste("my name is Ana; Aesop", { qloo: qloo.client, llm: llm.llm });

    expect(llm.requests.at(-1)!.prompt).toBe("my name is Ana; Aesop");
    expect(qloo.calls.every((c) => !JSON.stringify(c.params).includes("Ana"))).toBe(true);
  });
});
