import { type HeatCell, parseHeatmap } from "../geo/heatmap.ts";
import type { QlooClient } from "./client.ts";

export const ENTITY_TYPES = ["artist", "book", "brand", "movie", "place", "podcast", "tv_show"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface Candidate {
  id: string;
  name: string;
  type: string;
  image?: string;
  description?: string;
  popularity: number;
}

export interface TagCandidate {
  id: string;
  name: string;
  type: string;
}

export interface Signals {
  entities: string[];
  tags: string[];
}

export interface Place {
  id: string;
  name: string;
  genre: string;
  categories: string[];
  address?: string;
  neighborhood?: string;
  lat: number;
  lng: number;
  image?: string;
  rating?: number;
  affinity: number;
  description?: string;
  closed: boolean;
}

export interface SharedTag {
  id: string;
  name: string;
  score: number;
}

interface RawEntity {
  entity_id: string;
  name: string;
  types: string[];
  popularity?: number;
  properties?: { image?: { url?: string }; short_description?: string };
}

interface RawPlace {
  entity_id: string;
  name: string;
  location?: { lat?: number; lon?: number };
  query?: { affinity?: number };
  tags?: { name: string; type: string }[];
  properties?: {
    address?: string;
    neighborhood?: string;
    business_rating?: number;
    is_closed?: boolean;
    short_description?: string;
    images?: { url?: string }[];
    primary_genre?: { id?: string };
  };
}

const signalParams = ({ entities, tags }: Signals) => ({
  ...(entities.length > 0 ? { "signal.interests.entities": entities } : {}),
  ...(tags.length > 0 ? { "signal.interests.tags": tags } : {}),
});

export async function searchEntities(qloo: QlooClient, query: string, type?: EntityType, take = 3): Promise<Candidate[]> {
  const { data } = await qloo.get<{ results?: RawEntity[] }>("/search", {
    query,
    take,
    ...(type ? { types: `urn:entity:${type}` } : {}),
  });
  return (data.results ?? []).map((e) => ({
    id: e.entity_id,
    name: e.name,
    type: (e.types[0] ?? "").replace("urn:entity:", ""),
    image: e.properties?.image?.url,
    description: e.properties?.short_description,
    popularity: e.popularity ?? 0,
  }));
}

export interface TagSearchOptions {
  take?: number;
  parentType?: string;
}

export async function searchTags(qloo: QlooClient, query: string, { take = 3, parentType }: TagSearchOptions = {}): Promise<TagCandidate[]> {
  const { data } = await qloo.get<{ results?: { tags?: TagCandidate[] } }>("/v2/tags", {
    "filter.query": query,
    take,
    ...(parentType ? { "filter.parents.types": parentType } : {}),
  });
  return (data.results?.tags ?? []).map(({ id, name, type }) => ({ id, name, type }));
}

export async function heatmap(qloo: QlooClient, signals: Signals, location: Record<string, string>): Promise<HeatCell[]> {
  const { data } = await qloo.get<Parameters<typeof parseHeatmap>[0]>("/v2/insights", {
    "filter.type": "urn:heatmap",
    ...signalParams(signals),
    ...location,
    take: 50,
  });
  return parseHeatmap(data);
}

export interface PlaceQuery {
  radiusM?: number;
  take?: number;
  includeTags?: string[];
  excludeTags?: string[];
}

export async function placesNear(
  qloo: QlooClient,
  signals: Signals,
  at: { lat: number; lng: number },
  { radiusM = 1200, take = 30, includeTags = [], excludeTags = [] }: PlaceQuery = {},
): Promise<Place[]> {
  const { data } = await qloo.get<{ results?: { entities?: RawPlace[] } }>("/v2/insights", {
    "filter.type": "urn:entity:place",
    ...signalParams(signals),
    "filter.location": `POINT(${at.lng} ${at.lat})`,
    "filter.location.radius": radiusM,
    ...(includeTags.length > 0 ? { "filter.tags": includeTags } : {}),
    ...(excludeTags.length > 0 ? { "filter.exclude.tags": excludeTags } : {}),
    take,
  });
  return (data.results?.entities ?? []).map((e) => ({
    id: e.entity_id,
    name: e.name,
    genre: e.properties?.primary_genre?.id ?? "",
    categories: (e.tags ?? []).filter((t) => t.type === "urn:tag:category:place").map((t) => t.name),
    address: e.properties?.address,
    neighborhood: e.properties?.neighborhood,
    lat: e.location?.lat ?? 0,
    lng: e.location?.lon ?? 0,
    image: e.properties?.images?.[0]?.url,
    rating: e.properties?.business_rating,
    affinity: e.query?.affinity ?? 0,
    description: e.properties?.short_description,
    closed: e.properties?.is_closed === true,
  }));
}

export async function compareTastes(qloo: QlooClient, a: Signals, b: Signals, take = 8): Promise<SharedTag[]> {
  if (a.entities.length === 0 || b.entities.length === 0) return [];
  const { data } = await qloo.get<{ results?: { tags?: { tag_id: string; name: string; query?: { score?: number } }[] } }>(
    "/v2/analysis/compare",
    { "a.signal.interests.entities": a.entities, "b.signal.interests.entities": b.entities, take },
  );
  return (data.results?.tags ?? []).map((t) => ({ id: t.tag_id, name: t.name, score: t.query?.score ?? 0 }));
}
