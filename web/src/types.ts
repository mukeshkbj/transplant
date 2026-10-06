export type { TraceStep } from "../../server/src/agent.ts";
export type { Demo } from "../../server/src/demos.ts";
export type { Place, SharedTag } from "../../server/src/qloo/api.ts";
export type { RefineAction, RefineInput, RefineResult } from "../../server/src/refine.ts";
export type { Chip, ChipOption } from "../../server/src/resolve.ts";
export type { RankedHood, Story } from "../../server/src/story.ts";
export type { MapCell, SignalStrength, TransplantEvent, TransplantInput } from "../../server/src/transplant.ts";

export interface CityInfo {
  id: string;
  name: string;
  beta: boolean;
  bbox: [south: number, west: number, north: number, east: number];
}
