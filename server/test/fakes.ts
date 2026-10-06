import { readFileSync } from "node:fs";
import type { JsonRequest, Llm } from "../src/llm/llm.ts";
import type { QlooClient, QlooParams } from "../src/qloo/client.ts";

export const fixture = <T = any>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;

export type QlooRoute = (path: string, params: QlooParams) => unknown;

export function fakeQloo(route: QlooRoute) {
  const calls: { path: string; params: QlooParams }[] = [];
  const client: QlooClient = {
    async get<T>(path: string, params: QlooParams) {
      calls.push({ path, params });
      const data = route(path, params);
      if (data === undefined) throw new Error(`Unexpected Qloo call ${path} ${JSON.stringify(params)}`);
      return { data: data as T, monthRemaining: 9000 };
    },
  };
  return { client, calls };
}

export function fakeLlm(respond: (req: JsonRequest<unknown>) => unknown) {
  const requests: JsonRequest<unknown>[] = [];
  const llm: Llm = {
    async json<T>(req: JsonRequest<T>): Promise<T> {
      requests.push(req as JsonRequest<unknown>);
      return req.schema.parse(await respond(req as JsonRequest<unknown>));
    },
  };
  return { llm, requests };
}
