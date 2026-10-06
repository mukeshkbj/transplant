import type { ChipOption } from "./types.ts";

export interface PicksPayload {
  cityId: string;
  mode: "moving" | "visiting";
  people: { label: string; picks: ChipOption[] }[];
}

type Compact = { c: string; m: "moving" | "visiting"; p: { l: string; k: [id: string, name: string, type: string, concept: 0 | 1][] }[] };

const toBase64Url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (token: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(token.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0)));

export function encodeShare(payload: PicksPayload): string {
  const compact: Compact = {
    c: payload.cityId,
    m: payload.mode,
    p: payload.people.map((p) => ({ l: p.label, k: p.picks.map((o) => [o.id, o.name, o.type, o.kind === "concept" ? 1 : 0]) })),
  };
  return toBase64Url(JSON.stringify(compact));
}

export function decodeShare(token: string): PicksPayload | undefined {
  try {
    const c = JSON.parse(fromBase64Url(token)) as Compact;
    if (typeof c.c !== "string" || (c.m !== "moving" && c.m !== "visiting") || !Array.isArray(c.p) || c.p.length < 1 || c.p.length > 2) return undefined;
    return {
      cityId: c.c,
      mode: c.m,
      people: c.p.map((p) => ({
        label: String(p.l).slice(0, 40),
        picks: p.k.slice(0, 15).map(([id, name, type, concept]) => ({
          id: String(id),
          name: String(name),
          type: String(type),
          kind: concept ? ("concept" as const) : ("entity" as const),
        })),
      })),
    };
  } catch {
    return undefined;
  }
}
