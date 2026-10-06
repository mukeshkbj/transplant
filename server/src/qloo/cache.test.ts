import { describe, expect, it, vi } from "vitest";
import { cacheKey, withCache } from "./cache.ts";
import type { QlooClient } from "./client.ts";

const fakeInner = () => {
  const get = vi.fn(async (path: string) => ({ data: { path }, monthRemaining: 42 }));
  return { client: { get } as unknown as QlooClient, get };
};

describe("cacheKey", () => {
  it("is independent of param order and joins arrays", () => {
    expect(cacheKey("/v2/insights", { b: 1, a: ["x", "y"] })).toBe(cacheKey("/v2/insights", { a: ["x", "y"], b: 1 }));
    expect(cacheKey("/search", { query: "a b" })).toBe("/search?query=a+b");
  });
});

describe("withCache", () => {
  it("serves repeated requests from SQLite", async () => {
    const { client, get } = fakeInner();
    const cached = withCache(client, ":memory:");

    const first = await cached.get("/search", { query: "Khruangbin" });
    const second = await cached.get("/search", { query: "Khruangbin" });

    expect(get).toHaveBeenCalledTimes(1);
    expect(first.data).toEqual(second.data);
    expect(second.monthRemaining).toBeUndefined();
  });

  it("refetches after the TTL expires", async () => {
    const { client, get } = fakeInner();
    let t = 0;
    const cached = withCache(client, ":memory:", 1000, () => t);

    await cached.get("/search", { query: "x" });
    t = 1001;
    await cached.get("/search", { query: "x" });

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ data: 1, monthRemaining: 1 });
    const cached = withCache({ get } as unknown as QlooClient, ":memory:");

    await expect(cached.get("/search", {})).rejects.toThrow("boom");
    await expect(cached.get("/search", {})).resolves.toMatchObject({ data: 1 });
  });
});
