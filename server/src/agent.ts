import { LlmError } from "./llm/llm.ts";
import type { ChatMessage, ToolProvider, ToolSpec } from "./llm/tools.ts";

export interface AgentTool {
  spec: ToolSpec;
  run(args: Record<string, unknown>): Promise<{ result: unknown; summary: string }>;
}

export interface TraceStep {
  tool: string;
  summary: string;
}

export interface AgentResult {
  reply: string;
  trace: TraceStep[];
  provider: string;
}

interface AgentOptions {
  providers: ToolProvider[];
  system: string;
  prompt: string;
  tools: AgentTool[];
  maxSteps?: number;
  log?: (message: string) => void;
}

export async function runAgent({ providers, system, prompt, tools, maxSteps = 5, log = console.warn }: AgentOptions): Promise<AgentResult> {
  const specs = tools.map((t) => t.spec);
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const failures: string[] = [];

  for (const provider of providers) {
    const messages: ChatMessage[] = [{ role: "user", text: prompt }];
    const trace: TraceStep[] = [];
    try {
      for (let step = 0; step < maxSteps; step++) {
        const turn = await provider.turn({ system, messages, tools: specs });
        if (turn.calls.length === 0) return { reply: turn.text, trace, provider: provider.name };
        messages.push({ role: "assistant", text: turn.text, calls: turn.calls });
        for (const call of turn.calls) {
          const tool = byName.get(call.name);
          const { result, summary } = tool
            ? await tool.run(call.args).catch((error: unknown) => ({
                result: { error: (error as Error).message },
                summary: `${call.name} failed: ${(error as Error).message}`,
              }))
            : { result: { error: `Unknown tool ${call.name}` }, summary: `unknown tool ${call.name}` };
          trace.push({ tool: call.name, summary });
          messages.push({ role: "tool", call, result });
        }
      }
      throw new Error(`no answer within ${maxSteps} steps`);
    } catch (error) {
      failures.push(`${provider.name}: ${(error as Error).message}`);
      log(`Agent fallback (${failures.at(-1)})`);
    }
  }
  throw new LlmError(`Agent failed: ${failures.join("; ")}`);
}
