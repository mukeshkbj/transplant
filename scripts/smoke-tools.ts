import { loadConfig } from "../server/src/config.ts";
import { type ChatMessage, geminiTools, groqTools, type ToolProvider, type ToolSpec } from "../server/src/llm/tools.ts";

const config = loadConfig();
const tools: ToolSpec[] = [
  {
    name: "find_tags",
    description: "Find Qloo tag ids for a quality.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];
const providers: ToolProvider[] = [
  geminiTools({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL }),
  ...(config.GROQ_API_KEY ? [groqTools({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL })] : []),
];

const timed = async <T>(work: () => Promise<T>) => {
  const start = Date.now();
  const value = await work();
  return { value, ms: Date.now() - start };
};

for (const p of providers) {
  try {
    const messages: ChatMessage[] = [{ role: "user", text: "Find the tag for quiet places, then tell me its id." }];
    const first = await timed(() => p.turn({ system: "Use tools before answering.", messages, tools }));
    const calls = first.value.calls.map((c) => ({ name: c.name, args: c.args, signed: Boolean(c.signature) }));
    console.log(`${p.name} turn 1 (${first.ms} ms) calls: ${JSON.stringify(calls)}`);
    messages.push({ role: "assistant", text: first.value.text, calls: first.value.calls });
    for (const call of first.value.calls) messages.push({ role: "tool", call, result: [{ id: "urn:tag:ambience:qloo:quiet", name: "Quiet" }] });
    const second = await timed(() => p.turn({ system: "Use tools before answering.", messages, tools }));
    console.log(`${p.name} turn 2 (${second.ms} ms): ${second.value.text.slice(0, 160)} | more calls: ${second.value.calls.length}`);
  } catch (error) {
    console.log(`${p.name} FAILED: ${(error as Error).message}`);
  }
}
