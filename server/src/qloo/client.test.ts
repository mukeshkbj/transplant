import { describe, expect, it, vi } from "vitest";
import { createQlooClient, QlooError } from "./client.ts";

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const makeClock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
};

const setup = (...responses: Response[]) => {
  const clock = makeClock();
  const fetchImpl = vi.fn<typeof fetch>();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  const client = createQlooClient({ apiKey: "test-key", fetchImpl, sleep: clock.sleep, now: clock.now });
  return { client, fetchImpl, clock };
};

describe("createQlooClient", () => {
  it("sends the API key header and joins array params", async () => {
    const { client, fetchImpl } = setup(jsonResponse({ ok: 1 }, 200, { "x-month-ratelimit-remaining": "9000" }));

    const res = await client.get("/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": ["A", "B"], take: 50 });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://hackathon.api.qloo.com/v2/insights?filter.type=urn%3Aheatmap&signal.interests.entities=A%2CB&take=50",
    );
    expect(new Headers(init?.headers).get("X-Api-Key")).toBe("test-key");
    expect(res).toEqual({ data: { ok: 1 }, monthRemaining: 9000 });
  });

  it("spaces sequential calls by minIntervalMs", async () => {
    const { client, clock } = setup(jsonResponse({}), jsonResponse({}));

    await Promise.all([client.get("/search", { query: "a" }), client.get("/search", { query: "b" })]);

    expect(clock.sleeps).toEqual([250]);
  });

  it("waits for the per-second reset and retries on 429", async () => {
    const { client, fetchImpl, clock } = setup(
      jsonResponse({ error_msg: "Rate limit exceeded" }, 429, { "x-second-ratelimit-reset": "0.3" }),
      jsonResponse({ results: [] }),
    );

    const res = await client.get("/search", { query: "Metallica" });

    expect(res.data).toEqual({ results: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toContain(300);
  });

  it("throws a non-retryable QlooError on 400 without retrying", async () => {
    const { client, fetchImpl } = setup(jsonResponse({ errors: [{ message: "take must be <= 50" }] }, 400));

    const error = await client.get("/v2/insights", { take: 200 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QlooError);
    expect(error).toMatchObject({ status: 400, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries consecutive 429s", async () => {
    const limited = () => jsonResponse({}, 429, { "x-second-ratelimit-reset": "0.1" });
    const { client, fetchImpl } = setup(limited(), limited(), limited());

    const error = await client.get("/search", { query: "x" }).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 429, retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps serving the queue after a failed request", async () => {
    const { client } = setup(jsonResponse({}, 404), jsonResponse({ ok: true }));

    await client.get("/nope", {}).catch(() => undefined);
    const res = await client.get("/search", { query: "x" });

    expect(res.data).toEqual({ ok: true });
  });
});
