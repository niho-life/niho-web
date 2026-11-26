import { afterEach, beforeEach, test } from "node:test";

/** Keep timer driven UI tests deterministic without waiting for wall clock time. */
export function createTestClock(act, apis = ["setTimeout"]) {
  let timers;

  beforeEach((context) => {
    context.mock.timers.enable({ apis });
    timers = context.mock.timers;
  });
  afterEach(() => { timers = undefined; });

  const wait = (milliseconds = 0) => act(async () => {
    if (!timers) throw new Error("wait() must run inside a test created by createTestClock()");
    let remaining = Math.max(1, milliseconds);
    while (remaining > 0) {
      const step = Math.min(10, remaining);
      timers.tick(step);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      remaining -= step;
    }
  });

  return { test, wait };
}
