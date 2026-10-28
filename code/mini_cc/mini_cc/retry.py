"""API 层重试：指数退避 + 抖动，优先尊重服务端给的 retry-after。"""

from __future__ import annotations

import random
from dataclasses import dataclass

from .model import ModelError


@dataclass
class RetryPolicy:
    max_retries: int = 5
    base_delay: float = 1.0
    max_delay: float = 30.0

    def delay(self, attempt: int, err: ModelError, rng: random.Random | None = None) -> float:
        """attempt 从 1 开始：第 1 次重试前等多久。"""
        if err.retry_after is not None:
            return min(err.retry_after, self.max_delay)
        r = (rng or random).uniform(0, 0.5)
        return min(self.base_delay * 2 ** (attempt - 1) + r, self.max_delay)

    def should_retry(self, attempt: int, err: ModelError) -> bool:
        return err.retryable and attempt <= self.max_retries
