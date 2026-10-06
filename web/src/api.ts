import { createSseParser } from "./sse.ts";
import type { Chip, CityInfo, Place, TransplantEvent, TransplantInput } from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const FRIENDLY: Record<string, string> = {
  RATE_LIMITED: "You've hit the hourly limit for live lookups. Try again soon.",
  BAD_REQUEST: "That request didn't look right. Check your picks and try again.",
};

const toError = async (res: Response) => {
  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  const code = body.code ?? `HTTP_${res.status}`;
  return new ApiError(code, body.message ?? FRIENDLY[code] ?? "Something went wrong. Try again.");
};

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export const fetchCities = () => request<CityInfo[]>("/api/cities");

export const resolveTaste = async (text: string) => (await request<{ chips: Chip[] }>("/api/resolve", post({ text }))).chips;

export const fetchPlaces = async (input: Pick<TransplantInput, "cityId" | "people">, hoodId: string) =>
  (await request<{ places: Place[] }>("/api/places", post({ cityId: input.cityId, people: input.people, hoodId }))).places;

export async function streamTransplant(input: TransplantInput, onEvent: (event: TransplantEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/transplant", { ...post(input), signal });
  if (!res.ok || !res.body) throw await toError(res);
  const feed = createSseParser(onEvent);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    feed(value);
  }
}
