import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare } from "./share.ts";

const payload = {
  cityId: "london",
  mode: "moving" as const,
  people: [
    {
      label: "You",
      picks: [
        { id: "E1", name: "Phoebe Bridgers", type: "artist", kind: "entity" as const },
        { id: "urn:tag:x", name: "Vintage — clothing", type: "urn:tag:y", kind: "concept" as const },
      ],
    },
  ],
};

describe("share", () => {
  it("round-trips picks through a URL-safe token, including non-ASCII names", () => {
    const token = encodeShare(payload);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShare(token)).toEqual(payload);
  });

  it("rejects malformed tokens", () => {
    expect(decodeShare("not-a-token")).toBeUndefined();
    expect(decodeShare(encodeShare({ ...payload, people: [] }))).toBeUndefined();
  });
});
