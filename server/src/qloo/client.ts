export type QlooParams = Record<string, string | number | readonly string[]>;

export class QlooError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "QlooError";
  }
}

export interface QlooResponse<T> {
  data: T;
  monthRemaining: number | undefined;
}

export interface QlooClient {
  get<T>(path: string, params: QlooParams): Promise<QlooResponse<T>>;
}

export interface QlooClientOptions {
  apiKey: string;
  baseUrl?: string;
  minIntervalMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildUrl(baseUrl: string, path: string, params: QlooParams): URL {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, typeof value === "object" ? value.join(",") : String(value));
  }
  return url;
}

export function createQlooClient(options: QlooClientOptions): QlooClient {
  const {
    apiKey,
    baseUrl = "https://hackathon.api.qloo.com",
    minIntervalMs = 250,
    maxRetries = 2,
    fetchImpl = fetch,
    sleep = defaultSleep,
    now = Date.now,
  } = options;
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt = Number.NEGATIVE_INFINITY;

  const throttle = async () => {
    const wait = lastAt + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();
  };

  const attempt = async <T>(url: URL): Promise<QlooResponse<T>> => {
    for (let i = 0; ; i++) {
      await throttle();
      let res: Response;
      try {
        res = await fetchImpl(url, { headers: { "X-Api-Key": apiKey }, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        if (i < 1) continue;
        throw new QlooError(`Qloo network error: ${(error as Error).message}`, 0, true);
      }
      if (res.ok) {
        const remaining = res.headers.get("x-month-ratelimit-remaining");
        return { data: (await res.json()) as T, monthRemaining: remaining === null ? undefined : Number(remaining) };
      }
      if (res.status === 429 && i < maxRetries) {
        await sleep(Number(res.headers.get("x-second-ratelimit-reset") ?? 1) * 1000);
        continue;
      }
      if (res.status >= 500 && i < 1) continue;
      const body = await res.text();
      throw new QlooError(
        `Qloo ${res.status} on ${url.pathname}: ${body.slice(0, 200)}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
  };

  return {
    get<T>(path: string, params: QlooParams) {
      const run = queue.then(() => attempt<T>(buildUrl(baseUrl, path, params)));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
