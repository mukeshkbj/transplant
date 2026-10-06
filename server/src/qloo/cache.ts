import { DatabaseSync } from "node:sqlite";
import type { QlooClient, QlooParams, QlooResponse } from "./client.ts";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function cacheKey(path: string, params: QlooParams): string {
  const entries = Object.keys(params)
    .sort()
    .map((key): [string, string] => {
      const value = params[key]!;
      return [key, typeof value === "object" ? value.join(",") : String(value)];
    });
  return `${path}?${new URLSearchParams(entries).toString()}`;
}

export function withCache(inner: QlooClient, dbPath: string, ttlMs = THIRTY_DAYS_MS, now = Date.now): QlooClient {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS qloo_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL)");
  const read = db.prepare("SELECT body, created_at FROM qloo_cache WHERE key = ?");
  const write = db.prepare("INSERT OR REPLACE INTO qloo_cache (key, body, created_at) VALUES (?, ?, ?)");

  return {
    async get<T>(path: string, params: QlooParams): Promise<QlooResponse<T>> {
      const key = cacheKey(path, params);
      const row = read.get(key) as { body: string; created_at: number } | undefined;
      if (row && now() - row.created_at < ttlMs) return { data: JSON.parse(row.body) as T, monthRemaining: undefined };
      const res = await inner.get<T>(path, params);
      write.run(key, JSON.stringify(res.data), now());
      return res;
    },
  };
}
