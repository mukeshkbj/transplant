import { describe, expect, it, vi } from "vitest";
import { type ChatMessage, geminiTools, groqTools, type ToolSpec } from "./tools.ts";

const tools: ToolSpec[] = [
  { name: "find_tags", description: "d", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
const ok = (body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
const sent = (f: ReturnType<typeof ok>) => JSON.parse(String(f.mock.calls[0]![1]?.body));

const history: ChatMessage[] = [
  { role: "user", text: "quieter please" },
  {
    role: "assistant",
    text: "",
    calls: [
      { id: "c1", name: "find_tags", args: { query: "quiet" }, signature: "sig-1" },
      { id: "c2", name: "find_tags", args: { query: "calm" } },
    ],
  },
  { role: "tool", call: { id: "c1", name: "find_tags", args: { query: "quiet" } }, result: [{ id: "urn:tag:a", name: "Quiet" }] },
  { role: "tool", call: { id: "c2", name: "find_tags", args: { query: "calm" } }, result: [] },
];

describe("geminiTools", () => {
  it("maps history to Gemini contents, echoes thought signatures, and groups function responses", async () => {
    const fetchImpl = ok({ candidates: [{ content: { parts: [{ text: "Done." }] } }] });

    const turn = await geminiTools({ apiKey: "k", model: "m", fetchImpl }).turn({ system: "sys", messages: history, tools });

    const body = sent(fetchImpl);
    expect(body.tools).toEqual([{ functionDeclarations: tools }]);
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[1].parts[0]).toEqual({ functionCall: { name: "find_tags", args: { query: "quiet" } }, thoughtSignature: "sig-1" });
    expect(body.contents[2].parts).toHaveLength(2);
    expect(body.contents[2].parts[0]).toEqual({ functionResponse: { name: "find_tags", response: { result: [{ id: "urn:tag:a", name: "Quiet" }] } } });
    expect(turn).toEqual({ text: "Done.", calls: [] });
  });

  it("parses function calls with their signatures and ignores thought text", async () => {
    const fetchImpl = ok({
      candidates: [
        {
          content: {
            parts: [{ text: "thinking", thought: true }, { functionCall: { name: "find_tags", args: { query: "quiet" } }, thoughtSignature: "sig-9" }],
          },
        },
      ],
    });

    const turn = await geminiTools({ apiKey: "k", model: "m", fetchImpl }).turn({ system: "s", messages: [{ role: "user", text: "x" }], tools });

    expect(turn).toEqual({ text: "", calls: [{ id: "call-1", name: "find_tags", args: { query: "quiet" }, signature: "sig-9" }] });
  });
});

describe("groqTools", () => {
  it("maps history to OpenAI-style messages and parses tool calls", async () => {
    const fetchImpl = ok({
      choices: [{ message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "find_tags", arguments: '{"query":"loud"}' } }] } }],
    });

    const turn = await groqTools({ apiKey: "k", model: "gm", fetchImpl }).turn({ system: "sys", messages: history, tools });

    const body = sent(fetchImpl);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect(body.messages[2].tool_calls[0]).toEqual({ id: "c1", type: "function", function: { name: "find_tags", arguments: '{"query":"quiet"}' } });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '[{"id":"urn:tag:a","name":"Quiet"}]' });
    expect(body.tools).toEqual([{ type: "function", function: tools[0] }]);
    expect(turn).toEqual({ text: "", calls: [{ id: "t1", name: "find_tags", args: { query: "loud" } }] });
  });
});
