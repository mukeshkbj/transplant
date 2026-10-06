import { describe, expect, it, vi } from "vitest";
import { fakeToolProvider } from "../test/fakes.ts";
import { type AgentTool, runAgent } from "./agent.ts";
import { LlmError } from "./llm/llm.ts";

const echo: AgentTool = {
  spec: { name: "echo", description: "d", parameters: { type: "object", properties: {} } },
  run: vi.fn(async (args) => ({ result: { got: args }, summary: `echoed ${JSON.stringify(args)}` })),
};

describe("runAgent", () => {
  it("executes tool calls, feeds results back, and returns the final reply with a trace", async () => {
    const { provider, requests } = fakeToolProvider("p", [
      { text: "", calls: [{ id: "1", name: "echo", args: { q: "quiet" } }] },
      { text: "Here you go.", calls: [] },
    ]);

    const out = await runAgent({ providers: [provider], system: "s", prompt: "hi", tools: [echo] });

    expect(out).toEqual({ reply: "Here you go.", trace: [{ tool: "echo", summary: 'echoed {"q":"quiet"}' }], provider: "p" });
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", result: { got: { q: "quiet" } } });
  });

  it("reports unknown tools and tool errors back to the model instead of crashing", async () => {
    const failing: AgentTool = { spec: { ...echo.spec, name: "boom" }, run: async () => Promise.reject(new Error("bad hood")) };
    const { provider, requests } = fakeToolProvider("p", [
      {
        text: "",
        calls: [
          { id: "1", name: "nope", args: {} },
          { id: "2", name: "boom", args: {} },
        ],
      },
      { text: "Sorry.", calls: [] },
    ]);

    const out = await runAgent({ providers: [provider], system: "s", prompt: "hi", tools: [failing] });

    expect(out.trace.map((t) => t.summary)).toEqual(["unknown tool nope", "boom failed: bad hood"]);
    expect(requests[1]!.messages.slice(-2).map((m) => (m.role === "tool" ? m.result : null))).toEqual([
      { error: "Unknown tool nope" },
      { error: "bad hood" },
    ]);
  });

  it("falls back to the next provider and restarts the conversation", async () => {
    const down = fakeToolProvider("down", () => {
      throw new Error("HTTP 503");
    });
    const up = fakeToolProvider("up", [{ text: "Fine.", calls: [] }]);

    const out = await runAgent({ providers: [down.provider, up.provider], system: "s", prompt: "hi", tools: [echo], log: () => {} });

    expect(out).toMatchObject({ reply: "Fine.", provider: "up", trace: [] });
  });

  it("gives up after maxSteps tool rounds", async () => {
    const loop = fakeToolProvider("loop", () => ({ text: "", calls: [{ id: "x", name: "echo", args: {} }] }));

    await expect(runAgent({ providers: [loop.provider], system: "s", prompt: "hi", tools: [echo], maxSteps: 2, log: () => {} })).rejects.toBeInstanceOf(
      LlmError,
    );
    expect(loop.requests).toHaveLength(2);
  });
});
