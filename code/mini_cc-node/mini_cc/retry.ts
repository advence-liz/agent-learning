/**
 * API 层重试：指数退避 + 抖动，优先尊重服务端给的 retry-after。（第 3 章）
 */

import type { ModelError } from "./model.ts";

export class RetryPolicy {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;

  constructor(maxRetries = 5, baseDelay = 1.0, maxDelay = 30.0) {
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
  }

  /** attempt 从 1 开始：第 1 次重试前等多久（秒）。 */
  delay(attempt: number, err: ModelError, rng: () => number = Math.random): number {
    if (err.retryAfter !== null) return Math.min(err.retryAfter, this.maxDelay);
    const r = rng() * 0.5;
    return Math.min(this.baseDelay * 2 ** (attempt - 1) + r, this.maxDelay);
  }

  shouldRetry(attempt: number, err: ModelError): boolean {
    return err.retryable && attempt <= this.maxRetries;
  }
}
