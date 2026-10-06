import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, resolveTaste, streamTransplant } from "./api.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("resolveTaste posts text and returns chips", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ chips: [{ query: "Aesop" }] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await resolveTaste("Aesop")).toEqual([{ query: "Aesop" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/resolve");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ text: "Aesop" });
  });

  it("maps error bodies to ApiError with a friendly message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "RATE_LIMITED" }, 429)));

    const error = await resolveTaste("x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", message: expect.stringMatching(/hourly limit/) });
  });

  it("streamTransplant reads SSE frames from the response body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(
          enc.encode('event: hoods\ndata: {"type":"hoods","hoods":[],"cells":[],"signal":{"level":"strong","topScore":0.04,"cells":13}}\n\n'),
        );
        controller.enqueue(enc.encode('event: done\ndata: {"type":"done"}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } })));
    const events: string[] = [];

    await streamTransplant({ cityId: "nyc", mode: "moving", people: [] }, (e) => events.push(e.type));

    expect(events).toEqual(["hoods", "done"]);
  });
});
