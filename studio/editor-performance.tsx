import { useState, useSyncExternalStore } from "react";
import { PageEditor, type EditorPerformanceOperation, type PageEditorProps } from "../src/editor.js";

const labels = {
  "initial-load": "最初のページが操作可能になるまで",
  "page-switch": "ページ切替",
  save: "下書き保存"
} satisfies Record<EditorPerformanceOperation, string>;
const operations = Object.keys(labels) as EditorPerformanceOperation[];
type Timings = Readonly<Partial<Record<EditorPerformanceOperation, number>>>;

function createRecorder() {
  const clock = window.performance;
  const navigation = clock.getEntriesByType?.("navigation")[0];
  let timings: Timings = {};
  const listeners = new Set<() => void>();
  return {
    read: () => timings,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin(operation: EditorPerformanceOperation) {
      const startTime = operation === "initial-load" ? navigation?.startTime ?? clock.now() : clock.now();
      return () => {
        const name = `niho-studio:editor:${operation}`;
        const start = `${name}:start`, end = `${name}:end`;
        clock.mark(start, { startTime });
        clock.mark(end);
        clock.clearMeasures(name);
        const { duration } = clock.measure(name, start, end);
        clock.clearMarks(start);
        clock.clearMarks(end);
        timings = { ...timings, [operation]: Math.round(duration) };
        for (const listener of listeners) listener();
      };
    }
  };
}

function PerformancePanel({ recorder }: { recorder: ReturnType<typeof createRecorder> }) {
  const timings = useSyncExternalStore(recorder.subscribe, recorder.read, recorder.read);
  return <details className="studio-editor-performance">
    <summary>編集画面の計測</summary>
    <dl>{operations.map((operation) => <div key={operation}>
      <dt>{labels[operation]}</dt>
      <dd>{timings[operation] === undefined ? "未計測" : `${timings[operation]} ms`}</dd>
    </div>)}</dl>
  </details>;
}

export function StudioPageEditor(props: PageEditorProps) {
  const [recorder] = useState(() => {
    if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("editorPerf") !== "1") return undefined;
    const clock = window.performance;
    if (typeof clock.mark === "function" && typeof clock.measure === "function") return createRecorder();
    return undefined;
  });
  return <>
    <PageEditor {...props} measurePerformance={recorder?.begin} />
    {recorder && <PerformancePanel recorder={recorder} />}
  </>;
}
