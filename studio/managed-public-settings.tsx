import { useEffect, useState, type FormEvent } from "react";
import type { Project } from "../src/projects.js";
import { parseManagedSiteRedirects, type ManagedSiteRedirect } from "../src/managed-site-redirects.js";
import { api, ApiError, record, SessionExpiredError, text } from "./api-client.js";

export function ManagedPublicSettings({ project, expire }: { project: Project; expire: () => void }) {
  const path = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}/editor/public-settings`;
  const seoPath = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}/editor/seo-settings`;
  const domainPath = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}/editor/public-domain`;
  const redirectsPath = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}/editor/redirects`;
  const [version, setVersion] = useState("");
  const [seoVersion, setSeoVersion] = useState("");
  const [frames, setFrames] = useState("");
  const [resources, setResources] = useState("");
  const [siteName, setSiteName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultOgImage, setDefaultOgImage] = useState("");
  const [verificationTags, setVerificationTags] = useState("[]");
  const [organization, setOrganization] = useState("null");
  const [robotsPolicy, setRobotsPolicy] = useState<"index" | "noindex">("index");
  const [measurementId, setMeasurementId] = useState("");
  const [message, setMessage] = useState("");
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [domainVersion, setDomainVersion] = useState("");
  const [domain, setDomain] = useState("");
  const [domainNoindex, setDomainNoindex] = useState(true);
  const [redirectVersion, setRedirectVersion] = useState("");
  const [redirects, setRedirects] = useState<ManagedSiteRedirect[]>([]);
  const [newRedirectLocale, setNewRedirectLocale] = useState("ja");
  const [newRedirectFrom, setNewRedirectFrom] = useState("");
  const [newRedirectTo, setNewRedirectTo] = useState("");

  function apply(value: unknown) {
    const source = record(value), settings = record(source.settings);
    if (!Array.isArray(settings.frameOrigins) || !Array.isArray(settings.resourceOrigins)) throw new Error("配信設定の形式を確認できません。");
    setFrames(settings.frameOrigins.map((entry) => text(entry, 253)).join("\n"));
    setResources(settings.resourceOrigins.map((entry) => text(entry, 253)).join("\n"));
    setVersion(text(source.version, 200));
  }
  function applySeo(value: unknown) {
    const source = record(value), settings = record(source.settings);
    setSiteName(settings.siteName === null ? "" : text(settings.siteName, 200));
    setDescription(settings.description === null ? "" : text(settings.description, 500));
    setDefaultOgImage(settings.defaultOgImage === null ? "" : text(settings.defaultOgImage, 2048));
    setVerificationTags(JSON.stringify(Array.isArray(settings.verificationTags) ? settings.verificationTags : []));
    setOrganization(JSON.stringify(settings.organization ?? null, null, 2));
    setRobotsPolicy(settings.robotsPolicy === "noindex" ? "noindex" : "index");
    setMeasurementId(settings.ga4MeasurementId === null ? "" : text(settings.ga4MeasurementId, 22));
    const currentVersion = text(source.version, 200);
    setSeoVersion(currentVersion);
    setVersion(currentVersion);
  }
  function applyDomain(value: unknown) {
    const source = record(value);
    setDomain(source.domain === null ? "" : text(source.domain, 253));
    setDomainNoindex(source.noindex !== false);
    setDomainVersion(text(source.version, 200));
  }
  function applyRedirects(value: unknown) {
    const source = record(value), parsed = parseManagedSiteRedirects(source.redirects);
    if (!parsed) throw new Error("redirect設定の形式を確認できません。");
    setRedirects(parsed);
    setRedirectVersion(text(source.version, 200));
  }

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api(path, { signal: controller.signal }), api(seoPath, { signal: controller.signal }), api(domainPath, { signal: controller.signal }), api(redirectsPath, { signal: controller.signal })]).then(([value, seoValue, domainValue, redirectsValue]) => {
      if (!controller.signal.aborted) { apply(value); applySeo(seoValue); applyDomain(domainValue); applyRedirects(redirectsValue); }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.status === 403) setHidden(true);
      else setMessage("公開配信の設定を読み込めませんでした。");
    });
    return () => controller.abort();
  }, [path, seoPath, domainPath, redirectsPath, expire, attempt]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!version || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const frameOrigins = [...new Set(frames.split(/\s+/u).filter(Boolean))];
      const resourceOrigins = [...new Set(resources.split(/\s+/u).filter(Boolean))];
      const result = await api(path, { method: "POST", body: { expectedVersion: version, settings: { frameOrigins, resourceOrigins } } });
      apply(result);
      const updatedVersion = text(record(result).version, 200);
      setSeoVersion(updatedVersion);
      setMessage("公開配信の設定を保存しました。");
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.status === 409) setMessage("別の変更が保存されました。再読込して設定を確認してください。");
      else if (error instanceof ApiError && error.status === 422) setMessage("HTTPS origin と GA4 測定 ID の形式を確認してください。");
      else setMessage("公開配信の設定を保存できませんでした。");
    } finally { setBusy(false); }
  }

  async function saveSeo(event: FormEvent) {
    event.preventDefault();
    if (!seoVersion || busy) return;
    setBusy(true);
    setMessage("");
    try {
      let tags: unknown, structured: unknown;
      try { tags = JSON.parse(verificationTags); structured = JSON.parse(organization); }
      catch { setMessage("確認タグと組織データのJSON形式を確認してください。"); return; }
      const settings = { siteName: siteName.trim() || null, description: description.trim() || null,
        defaultOgImage: defaultOgImage.trim() || null, verificationTags: tags, organization: structured,
        robotsPolicy, ga4MeasurementId: measurementId.trim() || null };
      const result = await api(seoPath, { method: "POST", body: { expectedVersion: seoVersion, settings } });
      applySeo(result);
      setMessage("SEO設定を保存しました。公開ページは次回の公開で更新されます。");
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.status === 409) setMessage("公開設定が別に更新されました。再読込して確認してください。");
      else if (error instanceof ApiError && error.status === 422) setMessage("SEO設定のURL・確認タグ・組織データを確認してください。");
      else setMessage("SEO設定を保存できませんでした。");
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

  function addRedirect(event: FormEvent) {
    event.preventDefault();
    const updated = parseManagedSiteRedirects([...redirects, { locale: newRedirectLocale.trim(), fromPath: newRedirectFrom.trim(), toPath: newRedirectTo.trim() }]);
    if (!updated) { setMessage("言語とURLパスを確認してください。転送元の重複や転送ループは登録できません。"); return; }
    setRedirects(updated);
    setNewRedirectFrom("");
    setNewRedirectTo("");
    setMessage("変更はまだ保存されていません。");
  }

  async function saveRedirects() {
    if (!redirectVersion || busy) return;
    setBusy(true);
    setMessage("");
    try {
      applyRedirects(await api(redirectsPath, { method: "PUT", body: { expectedVersion: redirectVersion, redirects } }));
      setMessage("redirectを保存しました。旧URLから新URLへ301で転送します。");
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.status === 409) setMessage("redirectが別に更新されました。再読込して確認してください。");
      else if (error instanceof ApiError && error.status === 422) setMessage("redirectの言語とURLパスを確認してください。");
      else setMessage("redirectを保存できませんでした。");
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
      <div><button type="submit" disabled={busy}>保存</button></div>
    </form>}
    {seoVersion && <form className="studio-public-settings-form" onSubmit={(event) => void saveSeo(event)}>
      <h3>サイトのSEO</h3>
      <label>サイト名
        <input disabled={busy} maxLength={200} type="text" value={siteName} onChange={(event) => setSiteName(event.target.value)} placeholder={project.site.name} />
      </label>
      <label>サイトの説明
        <textarea disabled={busy} rows={3} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label>既定のOGP画像URL
        <input disabled={busy} maxLength={2048} type="text" autoComplete="off" spellCheck={false} value={defaultOgImage} onChange={(event) => setDefaultOgImage(event.target.value)} placeholder="https://example.com/og.png または /images/og.png" />
      </label>
      <label>所有権確認タグ（JSON配列）
        <textarea disabled={busy} rows={3} maxLength={5000} spellCheck={false} value={verificationTags} onChange={(event) => setVerificationTags(event.target.value)} />
      </label>
      <details><summary>組織の構造化データ（JSON）</summary>
        <textarea disabled={busy} rows={6} maxLength={5000} spellCheck={false} value={organization} onChange={(event) => setOrganization(event.target.value)} />
        <p className="studio-help">null または {`{"name":"組織名","url":"https://example.com","logo":null,"sameAs":[]}`} を指定します。</p>
      </details>
      <label>robots
        <select disabled={busy} value={robotsPolicy} onChange={(event) => setRobotsPolicy(event.target.value === "noindex" ? "noindex" : "index")}>
          <option value="index">検索対象にする</option><option value="noindex">検索対象にしない</option>
        </select>
      </label>
      <label>GA4 測定 ID
        <input disabled={busy} maxLength={22} type="text" autoComplete="off" spellCheck={false} value={measurementId} onChange={(event) => setMeasurementId(event.target.value)} placeholder="G-XXXXXXXXXX" />
      </label>
      <div><button type="submit" disabled={busy}>SEO設定を保存</button></div>
    </form>}
    {redirectVersion && <div className="studio-public-settings-form">
      <h3>旧URLからの転送</h3>
      <p className="studio-help">サイト内のURLパスを登録すると、旧URLから新URLへ301で転送します。同じ旧URLは1件だけ登録できます。言語は一覧の管理用です。</p>
      <form onSubmit={addRedirect}>
        <label>言語
          <input disabled={busy} maxLength={40} type="text" value={newRedirectLocale} onChange={(event) => setNewRedirectLocale(event.target.value)} placeholder="ja" />
        </label>
        <label>旧URLパス
          <input disabled={busy} maxLength={160} type="text" autoComplete="off" spellCheck={false} value={newRedirectFrom} onChange={(event) => setNewRedirectFrom(event.target.value)} placeholder="/old-page" />
        </label>
        <label>新URLパス
          <input disabled={busy} maxLength={160} type="text" autoComplete="off" spellCheck={false} value={newRedirectTo} onChange={(event) => setNewRedirectTo(event.target.value)} placeholder="/new-page" />
        </label>
        <button type="submit" disabled={busy}>一覧に追加</button>
      </form>
      {redirects.length ? <ul aria-label="登録済みredirect">
        {redirects.map((redirect) => <li key={redirect.fromPath}>
          <code>{redirect.fromPath}</code> → <code>{redirect.toPath}</code> <span>({redirect.locale})</span>
          <button className="studio-secondary" type="button" disabled={busy} onClick={() => { setRedirects(redirects.filter(({ fromPath }) => fromPath !== redirect.fromPath)); setMessage("変更はまだ保存されていません。"); }}>削除</button>
        </li>)}
      </ul> : <p className="studio-help">redirectは登録されていません。</p>}
      <div><button type="button" disabled={busy} onClick={() => void saveRedirects()}>redirectを保存</button></div>
    </div>}
    {(message || !version) && <p role="status">{message || "公開配信の設定を読み込んでいます。"}</p>}
  </section>;
}
