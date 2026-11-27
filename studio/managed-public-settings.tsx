import { useEffect, useState, type FormEvent } from "react";
import type { Project } from "../src/projects.js";
import { api, ApiError, record, SessionExpiredError, text } from "./api-client.js";

export function ManagedPublicSettings({ project, expire }: { project: Project; expire: () => void }) {
  const path = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}/editor/public-settings`;
  const domainPath = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}/editor/public-domain`;
  const [version, setVersion] = useState("");
  const [frames, setFrames] = useState("");
  const [resources, setResources] = useState("");
  const [measurementId, setMeasurementId] = useState("");
  const [message, setMessage] = useState("");
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [domainVersion, setDomainVersion] = useState("");
  const [domain, setDomain] = useState("");
  const [domainNoindex, setDomainNoindex] = useState(true);

  function apply(value: unknown) {
    const source = record(value), settings = record(source.settings);
    if (!Array.isArray(settings.frameOrigins) || !Array.isArray(settings.resourceOrigins)) throw new Error("配信設定の形式を確認できません。");
    setFrames(settings.frameOrigins.map((entry) => text(entry, 253)).join("\n"));
    setResources(settings.resourceOrigins.map((entry) => text(entry, 253)).join("\n"));
    setMeasurementId(settings.ga4MeasurementId === null ? "" : text(settings.ga4MeasurementId, 22));
    setVersion(text(source.version, 200));
  }
  function applyDomain(value: unknown) {
    const source = record(value);
    setDomain(source.domain === null ? "" : text(source.domain, 253));
    setDomainNoindex(source.noindex !== false);
    setDomainVersion(text(source.version, 200));
  }

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api(path, { signal: controller.signal }), api(domainPath, { signal: controller.signal })]).then(([value, domainValue]) => {
      if (!controller.signal.aborted) { apply(value); applyDomain(domainValue); }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.status === 403) setHidden(true);
      else setMessage("公開配信の設定を読み込めませんでした。");
    });
    return () => controller.abort();
  }, [path, domainPath, expire, attempt]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!version || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const frameOrigins = [...new Set(frames.split(/\s+/u).filter(Boolean))];
      const resourceOrigins = [...new Set(resources.split(/\s+/u).filter(Boolean))];
      apply(await api(path, { method: "POST", body: {
        expectedVersion: version, settings: { frameOrigins, resourceOrigins, ga4MeasurementId: measurementId.trim() || null }
      } }));
      setMessage("公開配信の設定を保存しました。");
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.status === 409) setMessage("別の変更が保存されました。再読込して設定を確認してください。");
      else if (error instanceof ApiError && error.status === 422) setMessage("HTTPS origin と GA4 測定 ID の形式を確認してください。");
      else setMessage("公開配信の設定を保存できませんでした。");
    } finally { setBusy(false); }
  }

  async function saveDomain(event: FormEvent) {
    event.preventDefault();
    if (!domainVersion || busy) return;
    setBusy(true);
    setMessage("");
    try {
      applyDomain(await api(domainPath, { method: "POST", body: { expectedVersion: domainVersion, domain: domain.trim() || null, noindex: domainNoindex } }));
      setMessage("独自ドメインを保存しました。DNS と Worker の経路設定後に配信されます。");
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.status === 409) setMessage(error.code === "domain_taken" ? "このドメインは別のサイトで使用されています。" : "別の変更が保存されました。再読込して確認してください。");
      else if (error instanceof ApiError && error.status === 422) setMessage("独自ドメインはホスト名だけで入力してください（例: www.example.com）。");
      else setMessage("独自ドメインを保存できませんでした。");
    } finally { setBusy(false); }
  }

  if (hidden) return null;
  return <section className="studio-members" aria-label="公開配信">
    <div className="studio-section-heading"><h2>公開配信</h2><button className="studio-secondary" type="button" disabled={busy} onClick={() => { setMessage(""); setVersion(""); setAttempt((value) => value + 1); }}>再読込</button></div>
    {domainVersion && <form className="studio-public-settings-form" onSubmit={(event) => void saveDomain(event)}>
      <label>独自ドメイン
        <input disabled={busy} maxLength={253} type="text" autoComplete="off" spellCheck={false} value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="www.example.com" />
      </label>
      <p className="studio-help">https:// や path は含めず、ホスト名だけを入力します。DNS と Worker の経路設定が済むと、公開ページをこのドメインの root path から配信します。</p>
      <label><input type="checkbox" disabled={busy} checked={domainNoindex} onChange={(event) => setDomainNoindex(event.target.checked)} />検索エンジンに表示しない（検証用の初期設定）</label>
      <div><button type="submit" disabled={busy}>独自ドメインを保存</button></div>
    </form>}
    {version && <form className="studio-public-settings-form" onSubmit={(event) => void save(event)}>
      <label>埋め込みを許可する HTTPS origin
        <textarea disabled={busy} rows={4} maxLength={6100} spellCheck={false} value={frames} onChange={(event) => setFrames(event.target.value)} placeholder="https://www.youtube-nocookie.com" />
      </label>
      <p className="studio-help">URL の先頭にある https:// とドメインを、1行に1件入力します。保存すると公開済みのページにも反映されます。</p>
      <label>画像・動画を許可する HTTPS origin
        <textarea disabled={busy} rows={4} maxLength={6100} spellCheck={false} value={resources} onChange={(event) => setResources(event.target.value)} placeholder="https://media.example.com" />
      </label>
      <label>GA4 測定 ID
        <input disabled={busy} maxLength={22} type="text" autoComplete="off" spellCheck={false} value={measurementId} onChange={(event) => setMeasurementId(event.target.value)} placeholder="G-XXXXXXXXXX" />
      </label>
      <div><button type="submit" disabled={busy}>保存</button></div>
    </form>}
    {(message || !version) && <p role="status">{message || "公開配信の設定を読み込んでいます。"}</p>}
  </section>;
}
