import { type QlooClient, QlooError, type QlooParams, type QlooResponse } from "./client.ts";

export interface QuotaState {
  remaining: number | undefined;
}

export class QuotaLowError extends QlooError {
  constructor(floor: number) {
    super(`Qloo monthly quota is below ${floor}; only cached results are available`, 429, false);
    this.name = "QuotaLowError";
  }
}

export function withQuotaGuard(inner: QlooClient, floor: number, state: QuotaState = { remaining: undefined }): QlooClient {
  return {
    async get<T>(path: string, params: QlooParams): Promise<QlooResponse<T>> {
      if (state.remaining !== undefined && state.remaining < floor) throw new QuotaLowError(floor);
      const res = await inner.get<T>(path, params);
      if (res.monthRemaining !== undefined) state.remaining = res.monthRemaining;
      return res;
    },
  };
}
