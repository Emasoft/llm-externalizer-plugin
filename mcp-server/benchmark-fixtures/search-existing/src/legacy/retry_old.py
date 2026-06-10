# Benchmark fixture — real code with a KNOWN feature location (TRDD-828238b5 A6).
# Feature: retry with exponential backoff, in Python. Exists to test
# cross-extension discovery: a run with extensions [".ts", ".py"] must report
# this file alongside the two TypeScript retry implementations.

import random
import time
from typing import Callable, TypeVar

T = TypeVar("T")


def call_with_retries(
    fn: Callable[[], T],
    attempts: int = 5,
    base_delay: float = 0.2,
    max_delay: float = 10.0,
) -> T:
    """Call fn(), retrying on any exception with exponential backoff + jitter.

    The delay doubles after each failed attempt (capped at max_delay); the
    final failure is re-raised unchanged.
    """
    delay = base_delay
    for attempt in range(attempts):
        try:
            return fn()
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(delay + random.uniform(0, delay / 4))
            delay = min(delay * 2, max_delay)
    raise RuntimeError("unreachable")
