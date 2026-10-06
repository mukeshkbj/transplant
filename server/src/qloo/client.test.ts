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
});
