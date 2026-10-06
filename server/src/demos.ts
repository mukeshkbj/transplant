import { readFileSync } from "node:fs";
import type { ChipOption } from "./resolve.ts";
import type { TransplantInput } from "./transplant.ts";

export interface Demo {
  id: string;
  title: string;
  blurb: string;
  cityId: string;
  mode: "moving" | "visiting";
  people: { label: string; picks: ChipOption[] }[];
}

let cached: Demo[] | undefined;

export function loadDemos(): Demo[] {
  cached ??= JSON.parse(readFileSync(new URL("../data/demos.json", import.meta.url), "utf8")) as Demo[];
  return cached;
}

export const demoInput = (demo: Demo): TransplantInput => ({
  cityId: demo.cityId,
  mode: demo.mode,
  people: demo.people.map(({ label, picks }) => ({
    label,
    names: picks.map((o) => o.name),
    entities: picks.filter((o) => o.kind === "entity").map((o) => o.id),
    tags: picks.filter((o) => o.kind === "concept").map((o) => o.id),
  })),
});

export async function warmDemos(demos: Demo[], run: (input: TransplantInput) => Promise<void>, log: (message: string) => void = console.log) {
  for (const demo of demos) {
    try {
      await run(demoInput(demo));
      log(`Warmed demo ${demo.id}`);
    } catch (error) {
      log(`Demo warm-up failed for ${demo.id}: ${(error as Error).message}`);
    }
  }
}
