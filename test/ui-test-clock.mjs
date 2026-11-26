// React's act drains updates and promise callbacks after each timer tick.
export function useTestClock(t, act, { date = false } = {}) {
  t.mock.timers.enable(date
    ? { apis: ["setTimeout", "setInterval", "Date"], now: Date.now() }
    : { apis: ["setTimeout"] });
  return (milliseconds) => act(async () => { t.mock.timers.tick(milliseconds); });
}
