import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SiteLanguageSettings, type SiteLanguage } from "../src/site-language-settings.js";
import type { Project } from "../src/projects.js";
import { ApiError, api, record, role, SessionExpiredError, text, timestamp } from "./api-client.js";

type Role = "owner" | "editor";
type Member = {
  readonly subject: string;
  readonly email: string | null;
  readonly role: Role;
  readonly displayName: string;
  readonly createdAt: string;
  readonly isCurrent: boolean;
};
type Invitation = {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: "pending" | "expired" | "accepted" | "revoked";
};
type Administration = {
  readonly projectName: string;
  readonly siteName: string;
  readonly members: readonly Member[];
  readonly invitations: readonly Invitation[];
};
type AdministrationState =
  | { readonly status: "loading" }
  | { readonly status: "hidden" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly value: Administration };

function parseAdministration(value: unknown): Administration {
  const source = record(value);
  if (source.status !== "ready" || !Array.isArray(source.members) || !Array.isArray(source.invitations) || source.members.length > 500 || source.invitations.length > 100) throw new Error("invalid API response");
  const members = source.members.map((entry): Member => {
    const member = record(entry);
    return {
      subject: text(member.subject, 128),
      email: member.email === null ? null : text(member.email),
      role: role(member.role),
      displayName: text(member.displayName, 120),
      createdAt: text(member.createdAt, 40),
      isCurrent: member.isCurrent === true
    };
  });
  const invitations = source.invitations.map((entry): Invitation => {
    const invitation = record(entry);
    if (!(["pending", "expired", "accepted", "revoked"] as const).includes(invitation.status as Invitation["status"])) throw new Error("invalid API response");
    return {
      id: text(invitation.id, 64),
      email: text(invitation.email),
      role: role(invitation.role),
      createdAt: timestamp(invitation.createdAt),
      expiresAt: timestamp(invitation.expiresAt),
      status: invitation.status as Invitation["status"]
    };
  });
  return { projectName: text(source.projectName, 120), siteName: text(source.siteName, 120), members, invitations };
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function roleLabel(value: Role): string { return value === "owner" ? "オーナー" : "編集者"; }

function MemberAdministration({ project, expire }: { readonly project: Project; readonly expire: () => void }) {
  const [state, setState] = useState<AdministrationState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("editor");
  const [expiry, setExpiry] = useState(7);
  const [invitationUrl, setInvitationUrl] = useState("");
  const base = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}`;

  const load = useCallback((signal?: AbortSignal) => {
    setState({ status: "loading" });
    void api(`${base}/membership`, signal ? { signal } : {})
      .then(parseAdministration)
      .then((value) => setState({ status: "ready", value }))
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        if (error instanceof SessionExpiredError) { expire(); return; }
        if (error instanceof ApiError && error.status === 403) { setState({ status: "hidden" }); return; }
        setState({ status: "error" });
      });
  }, [base, expire]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const mutate = useCallback(async (path: string, body: Record<string, unknown>, successMessage: string) => {
    setBusy(true);
    setMessage("");
    try {
      await api(`${base}${path}`, { method: "POST", body });
      setMessage(successMessage);
      load();
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.code === "final_owner_required") setMessage("最後のオーナーは降格・削除できません。");
      else if (error instanceof ApiError && error.status === 403) { setState({ status: "hidden" }); setMessage(""); }
      else setMessage("操作を完了できませんでした。最新の状態を確認して再度お試しください。");
    } finally { setBusy(false); }
  }, [base, expire, load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setInvitationUrl("");
    try {
      const response = record(await api(`${base}/invitations`, { method: "POST", body: { email, role: inviteRole, expiresInDays: expiry } }));
      const url = text(response.invitationUrl, 2048);
      setInvitationUrl(url);
      setEmail("");
      setMessage("招待を作成しました。この画面で一度だけ表示される URL を安全に共有してください。");
      load();
    } catch (error) {
      if (error instanceof SessionExpiredError) expire();
      else if (error instanceof ApiError && error.status === 403) { setState({ status: "hidden" }); setMessage(""); }
      else setMessage("招待を作成できませんでした。入力と最新の権限を確認してください。");
    } finally { setBusy(false); }
  };

  if (state.status === "hidden") return <section className="studio-members" aria-label="プロジェクト設定"><div className="studio-section-heading"><div><h2>メンバー管理</h2></div></div><p className="studio-help">メンバーの招待・権限の変更・参加解除はプロジェクトのオーナーだけが行えます。変更が必要なときはオーナーに依頼してください。参加しているメンバーは左の「メンバー」で確認できます。</p></section>;
  if (state.status === "loading") return <section className="studio-members studio-members-loading" aria-live="polite">メンバー管理を確認しています。</section>;
  if (state.status === "error") return <section className="studio-members"><div className="studio-section-heading"><div><h2>メンバー管理</h2></div><button type="button" onClick={() => load()}>再読込</button></div><p role="alert">メンバー情報を取得できませんでした。</p></section>;
  const value = state.value;
  return <section className="studio-members" aria-label="メンバー管理">
    <div className="studio-section-heading"><div><h2>メンバー管理</h2><p>{value.projectName} / {value.siteName}</p></div><div className="studio-section-actions"><button type="button" className="studio-secondary" onClick={() => load()} disabled={busy}>再読込</button><button type="button" aria-expanded={showInvite} aria-controls="studio-invite-fields" onClick={() => setShowInvite((visible) => !visible)}>{showInvite ? "閉じる" : "招待"}</button></div></div>
    {message && <p className="studio-message" role="status">{message}</p>}
    {showInvite && <div id="studio-invite-fields" className="studio-invite-fields"><form className="studio-invite-form" onSubmit={(event) => { void create(event); }}>
      <label><span>招待するメールアドレス</span><input type="email" required maxLength={254} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
      <label><span>権限</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}><option value="editor">編集者</option><option value="owner">オーナー</option></select></label>
      <label><span>有効期間</span><select value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}><option value={1}>1日</option><option value={3}>3日</option><option value={7}>7日</option></select></label>
      <button type="submit" disabled={busy}>招待 URL を作成</button>
    </form>
    <p className="studio-help">メールは送信されません。本人が Cloudflare Access で同じメールアドレスにログインし、URL から明示的に承諾すると参加します。</p>
    {invitationUrl && <div className="studio-copy"><label><span>一度だけ表示される招待 URL</span><input readOnly value={invitationUrl} onFocus={(event) => event.currentTarget.select()} /></label><button type="button" onClick={() => { void navigator.clipboard.writeText(invitationUrl).then(() => setMessage("招待 URL をコピーしました。")).catch(() => setMessage("URL 欄を選択してコピーしてください。")); }}>コピー</button></div>}</div>}
    <div className="studio-admin-grid">
      <section><h3>参加メンバー</h3><div className="studio-table-wrap"><table className="studio-admin-table"><thead><tr><th scope="col">メンバー</th><th scope="col">権限</th><th scope="col">操作</th></tr></thead><tbody>{value.members.map((member) => <tr key={member.subject}>
        <th scope="row"><strong>{member.displayName}</strong>{member.isCurrent && <span className="studio-you">自分</span>}<small>{member.email ?? "メール未登録（bootstrap）"}</small></th>
        <td data-label="権限"><span className="studio-role">{roleLabel(member.role)}</span></td><td data-label="操作"><div className="studio-row-actions"><button type="button" className="studio-secondary" disabled={busy} onClick={() => { const next = member.role === "owner" ? "editor" : "owner"; if (window.confirm(`${member.displayName} を${roleLabel(next)}に変更しますか？`)) void mutate("/members/role", { subject: member.subject, role: next }, "権限を変更しました。"); }}>{member.role === "owner" ? "編集者に変更" : "オーナーに変更"}</button><button type="button" className="studio-danger" disabled={busy} onClick={() => { if (window.confirm(`${member.displayName} をプロジェクトから削除しますか？`)) void mutate("/members/remove", { subject: member.subject }, "メンバーを削除しました。"); }}>削除</button></div></td>
      </tr>)}</tbody></table></div></section>
      <section><h3>招待履歴</h3>{value.invitations.length === 0 ? <p className="studio-help">招待はまだありません。</p> : <div className="studio-table-wrap"><table className="studio-admin-table"><thead><tr><th scope="col">招待先</th><th scope="col">状態</th><th scope="col">操作</th></tr></thead><tbody>{value.invitations.map((invitation) => <tr key={invitation.id}>
        <th scope="row"><strong>{invitation.email}</strong><small>{roleLabel(invitation.role)} ・ 期限 {dateLabel(invitation.expiresAt)}</small></th>
        <td data-label="状態"><span className="studio-status">{{ pending: "承諾待ち", expired: "期限切れ", accepted: "承諾済み", revoked: "取消済み" }[invitation.status]}</span></td><td data-label="操作">{invitation.status === "pending" && <button type="button" className="studio-danger" disabled={busy} onClick={() => { if (window.confirm(`${invitation.email} への招待を取り消しますか？`)) void mutate("/invitations/revoke", { invitationId: invitation.id }, "招待を取り消しました。"); }}>取消</button>}</td>
      </tr>)}</tbody></table></div>}</section>
    </div>
  </section>;
}

export function StudioProjectSettings({ project, sourceLocale, expire }: { readonly project: Project; readonly sourceLocale?: SiteLanguage; readonly expire: () => void }) {
  return <div className="studio-project-settings">
    {sourceLocale && <SiteLanguageSettings value={{ sourceLocale, targetLocale: sourceLocale === "ja" ? "en" : "ja" }} locked={false} />}
    <MemberAdministration key={`${project.id}:${project.site.id}`} project={project} expire={expire} />
  </div>;
}
