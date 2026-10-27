"use client";

import { useEffect, useId, useState } from "react";
import { siteLanguageSettingsCss } from "./site-language-settings-style.js";

export type SiteLanguage = "ja" | "en";
export type SiteLanguagePair = { sourceLocale: SiteLanguage; targetLocale: SiteLanguage };
export type SiteLanguageSettingsProps = {
  value: SiteLanguagePair;
  /** 最初のサブ言語公開後はホスト側でも変更を拒否する。 */
  locked: boolean;
  /** 保存権限・対応ホストがある場合だけ渡す。ホストが認可・CAS・公開状態を検証する。 */
  onSave?: (next: SiteLanguagePair) => Promise<SiteLanguagePair>;
};

const label = (locale: SiteLanguage) => locale === "ja" ? "日本語" : "English";
const pair = (sourceLocale: SiteLanguage): SiteLanguagePair => ({ sourceLocale, targetLocale: sourceLocale === "ja" ? "en" : "ja" });

/** サイトの原文言語を選び、もう一方をサブとして示す。保存と公開後の固定はホストが担う。 */
export function SiteLanguageSettings({ value, locked, onSave }: SiteLanguageSettingsProps) {
  if (value.sourceLocale === value.targetLocale) throw new Error("source and target locales must differ");
  const id = useId();
  const [saved, setSaved] = useState(value.sourceLocale);
  const [draft, setDraft] = useState(value.sourceLocale);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { setSaved(value.sourceLocale); setDraft(value.sourceLocale); setMessage(""); }, [value.sourceLocale]);
  useEffect(() => { if (locked) { setDraft(saved); setMessage(""); } }, [locked, saved]);
  const editable = !locked && !!onSave;
  const save = async () => {
    if (!editable || busy || draft === saved) return;
    setBusy(true); setMessage("");
    try {
      const result = await onSave(pair(draft));
      if (result.sourceLocale !== draft || result.targetLocale !== pair(draft).targetLocale) throw new Error("保存後の言語設定が一致しません。読み込み直してください。");
      setSaved(result.sourceLocale); setMessage("言語設定を保存しました。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "言語設定を保存できませんでした。"); }
    finally { setBusy(false); }
  };
  return <section className="nw-language-settings" aria-labelledby={`${id}-title`}><style dangerouslySetInnerHTML={{ __html: siteLanguageSettingsCss }} />
    <h3 id={`${id}-title`}>言語</h3>
    <p>ページの原文に使う言語を選びます。もう一方の言語は翻訳して公開します。</p>
    <fieldset disabled={!editable || busy}><legend>メインの言語</legend><div className="nw-language-options">
      {(["ja", "en"] as const).map((locale) => <label className="nw-language-option" key={locale}><input type="radio" name={`${id}-source-locale`} value={locale} checked={draft === locale} onChange={() => { setDraft(locale); setMessage(""); }} />{label(locale)}</label>)}
    </div></fieldset>
    <div className="nw-language-direction"><span>メイン <strong>{label(draft)}</strong></span><b aria-hidden="true">→</b><span>サブ <strong>{label(pair(draft).targetLocale)}</strong></span></div>
    <p className="nw-language-note">{locked ? "サブの言語を最初に公開したため、言語は変更できません。" : !onSave ? "このサイトの言語設定は現在変更できません。" : "サブの言語を最初に公開すると、この設定は変更できなくなります。"}</p>
    {editable && <div className="nw-language-actions"><button type="button" disabled={busy || draft === saved} onClick={() => void save()}>{busy ? "保存中…" : "変更を保存"}</button>{message && <span role={message === "言語設定を保存しました。" ? "status" : "alert"}>{message}</span>}</div>}
  </section>;
}
