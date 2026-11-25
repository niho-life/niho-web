export type EditorPerformanceName = "load" | "page-switch" | "save";
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

export const EDITOR_PERFORMANCE_EVENT = "niho-editor-performance";
const latest = new Map<EditorPerformanceName, EditorPerformanceSample>();
let sequence = 0;

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
