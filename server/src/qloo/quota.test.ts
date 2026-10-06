import { describe, expect, it, vi } from "vitest";
import type { QlooClient } from "./client.ts";
import { QuotaLowError, withQuotaGuard } from "./quota.ts";

const inner = (remaining: number | undefined) => {
  const get = vi.fn(async () => ({ data: {}, monthRemaining: remaining }));
  return { client: { get } as unknown as QlooClient, get };
};

describe("withQuotaGuard", () => {
  it("records the latest monthly remaining count", async () => {
    const state = { remaining: undefined as number | undefined };
    await withQuotaGuard(inner(9000).client, 1500, state).get("/search", {});

    expect(state.remaining).toBe(9000);
  });

  it("refuses live calls once remaining drops below the floor", async () => {
    const { client, get } = inner(1499);
    const guarded = withQuotaGuard(client, 1500);

    await guarded.get("/search", {});
    await expect(guarded.get("/search", {})).rejects.toBeInstanceOf(QuotaLowError);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("ignores responses without a quota header", async () => {
    const state = { remaining: 5000 as number | undefined };
    await withQuotaGuard(inner(undefined).client, 1500, state).get("/search", {});

    expect(state.remaining).toBe(5000);
  });
});
