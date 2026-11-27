export type EditorPerformanceName = "load" | "page-switch" | "session-build" | "render" | "save";
export type EditorPerformanceOutcome = "success" | "failed";
export type EditorPerformanceSample = {
  readonly name: EditorPerformanceName;
  readonly durationMs: number;
  readonly outcome: EditorPerformanceOutcome;
};
export type EditorPerformanceMeasurement = {
  readonly name: EditorPerformanceName;
  readonly startMark: string;
  readonly endMark: string;
  readonly startedAt: number;
};
export type EditorReadPerformanceSample = {
  readonly source: "cache" | "304" | "200";
  readonly durationMs: number;
  readonly cachedSession?: boolean;
  readonly serverTiming: readonly { readonly name: string; readonly durationMs?: number }[];
};

export const EDITOR_PERFORMANCE_EVENT = "niho-editor-performance";
const latest = new Map<EditorPerformanceName, EditorPerformanceSample>();
let sequence = 0;
let latestRead: EditorReadPerformanceSample | undefined;

export function recordEditorReadPerformance(sample: EditorReadPerformanceSample): void {
  if (typeof window === "undefined") return;
  latestRead = { ...sample, serverTiming: sample.serverTiming.map((item) => ({ ...item })) };
  window.dispatchEvent(new Event(EDITOR_PERFORMANCE_EVENT));
}

export function markEditorReadCacheHit(): void {
  if (!latestRead || typeof window === "undefined") return;
  latestRead = { ...latestRead, cachedSession: true };
  window.dispatchEvent(new Event(EDITOR_PERFORMANCE_EVENT));
}

export function readEditorReadPerformance(): EditorReadPerformanceSample | undefined {
  return latestRead && { ...latestRead, serverTiming: latestRead.serverTiming.map((item) => ({ ...item })) };
}

/** Performance entries contain only static operation names; page IDs and document data are never recorded. */
export function beginEditorPerformance(name: EditorPerformanceName): EditorPerformanceMeasurement | null {
  if (typeof window === "undefined" || typeof globalThis.performance?.mark !== "function") return null;
  const id = ++sequence, prefix = `niho-editor:${name}`;
  const startMark = `${prefix}:start:${id}`, endMark = `${prefix}:end:${id}`;
  try {
    globalThis.performance.mark(startMark);
    globalThis.performance.clearMeasures(prefix);
    return { name, startMark, endMark, startedAt: globalThis.performance.now() };
  } catch { return null; }
}

export function finishEditorPerformance(measurement: EditorPerformanceMeasurement | null, outcome: EditorPerformanceOutcome = "success"): void {
  if (!measurement || typeof window === "undefined" || typeof globalThis.performance?.mark !== "function") return;
  const prefix = `niho-editor:${measurement.name}`;
  try {
    globalThis.performance.mark(measurement.endMark);
    globalThis.performance.measure(prefix, measurement.startMark, measurement.endMark);
    const durationMs = globalThis.performance.now() - measurement.startedAt;
    latest.set(measurement.name, { name: measurement.name, durationMs, outcome });
    globalThis.performance.clearMarks(measurement.startMark);
    globalThis.performance.clearMarks(measurement.endMark);
    window.dispatchEvent(new Event(EDITOR_PERFORMANCE_EVENT));
  } catch { /* Performance APIs may be disabled by the host browser. */ }
}

export function readEditorPerformance(): ReadonlyMap<EditorPerformanceName, EditorPerformanceSample> {
  return new Map(latest);
}
