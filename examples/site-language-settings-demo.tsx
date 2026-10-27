import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SiteLanguageSettings, type SiteLanguagePair } from "../src/site-language-settings.js";

function Demo() {
  const [value, setValue] = useState<SiteLanguagePair>({ sourceLocale: "ja", targetLocale: "en" });
  const [locked, setLocked] = useState(false);
  return <main className="demo"><header><small>NIHO Web · デモ</small><h1>サイトの言語</h1><p>設定はこのタブの中だけに保存されます。</p></header>
    <SiteLanguageSettings value={value} locked={locked} onSave={async (next) => { setValue(next); return next; }} />
    <button className="demo-lock" type="button" onClick={() => setLocked((current) => !current)}>{locked ? "初回公開前に戻す（デモ）" : "サブを初回公開した状態にする（デモ）"}</button>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Demo />);
