import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse.ts";

describe("createSseParser", () => {
  it("emits one event per frame even when frames split across chunks", () => {
    const events: unknown[] = [];
    const feed = createSseParser((e) => events.push(e));

    feed('event: step\ndata: {"type":"step","id":"map"');
    feed(',"label":"Mapping","status":"running"}\n\nevent: done\r\ndata: {"type":"done"}\r\n\r\n');

    expect(events).toEqual([{ type: "step", id: "map", label: "Mapping", status: "running" }, { type: "done" }]);
  });

  it("ignores frames without data", () => {
    const events: unknown[] = [];
    createSseParser((e) => events.push(e))(": keep-alive\n\n");

    expect(events).toEqual([]);
  });
});
