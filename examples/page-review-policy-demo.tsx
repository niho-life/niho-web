import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PageSettings, type SiteSettingsState } from "../src/editor-pages.js";
import { editDocument } from "../src/editor-model.js";
import type { PageDocument } from "../src/types.js";

// 架空のページ。保存先はこのタブのメモリだけ。
const initial: PageDocument = {
  schemaVersion: 1, siteId: "demo", pageId: "terms", locale: "ja-JP", revision: 1,
  title: "利用規約", meta: { targetReviewBeforePublish: true }, tokens: {}, body: [],
};

function Demo() {
  const [document, setDocument] = useState(initial);
  const [notice, setNotice] = useState("");
  return <main className="nw-editor demo">
    <header><span>NIHO Web · デモ</span><h1>ページの公開設定</h1><p>変更はブラウザの中だけに保存されます。</p></header>
    <PageSettings document={document} page={{ siteId: "demo", pageId: "terms", locale: "ja-JP", title: "利用規約", path: "/terms" }}
      site={undefined} settings={{ settings: undefined } as SiteSettingsState} field={() => null}
      apply={(operation) => { setDocument((current) => editDocument(current, operation)); setNotice("設定を変更しました。公開条件にはホストが適用します。"); return undefined; }}
      report={setNotice} disabled={false} hasTargetLocale operations={false} operationsDisabled={false} unsaved={false} start={() => undefined} />
    <footer role="status">{notice || `保存値：${String(document.meta?.targetReviewBeforePublish)}`}</footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Demo />);
