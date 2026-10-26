/**
 * Dashboard の「翻訳」（鎌倉）を Studio の翻訳の画面（LocalizationWorkspace）で開く中身。
 * 画面の部品が大きいので、client からは翻訳を開いたときだけ import() で読む（studio/site-translations.tsx）。
 */
import { LocalizationItemWorkspace, LocalizationWorkspace, type LocalizationNavigationState, type LocalizationWorkspaceAdapter } from "../src/localization-workspace.js";
import { KAMAKURA_CMS_PROJECT_ID, KAMAKURA_CMS_SITE_ID } from "./kamakura-cms-contract.js";
import { createKamakuraLocalizationAdapter } from "./kamakura-localization.js";
import { projectAliasPath, type ProjectTranslationsRoute } from "./project-routes.mjs";
import type { SiteCmsView } from "./site-admin.mjs";

const adapters = new Map<string, LocalizationWorkspaceAdapter>();

/**
 * adapter は描画の外でサイトと CMS の開き方ごとに 1 回だけ作る。作り直すと LocalizationWorkspace が中身を読み直し、進行中の保存を止める。
 * 原文が CMS の項目なら Studio の CMS で開く（CMS がコレクション画面ならその項目、枠なら CMS の入口）。
 */
function adapterFor(cmsView: SiteCmsView, siteOrigin: string | null): LocalizationWorkspaceAdapter {
  const key = `${cmsView}\u0000${siteOrigin ?? ""}`;
  const existing = adapters.get(key);
  if (existing) return existing;
  const adapter = createKamakuraLocalizationAdapter({
    siteOrigin,
    pageTranslationUrl: (pageId) => {
      const path = projectAliasPath(KAMAKURA_CMS_PROJECT_ID, KAMAKURA_CMS_SITE_ID, "editor");
      return path ? `${path}?page=${encodeURIComponent(pageId)}&lang=en` : null;
    },
    cmsItemUrl: (collectionId, itemId) => projectAliasPath(KAMAKURA_CMS_PROJECT_ID, KAMAKURA_CMS_SITE_ID, "cms", cmsView === "workspace" ? { collectionId, itemId } : null),
    ...(cmsView === "workspace" ? { cmsTranslationUrl: (collectionId: string, itemId: string) => {
      const path = projectAliasPath(KAMAKURA_CMS_PROJECT_ID, KAMAKURA_CMS_SITE_ID, "cms", { collectionId, itemId });
      return path ? `${path}?lang=en` : null;
    } } : {})
  });
  adapters.set(key, adapter);
  return adapter;
}

export type KamakuraLocalizationWorkspaceProps = {
  /** Dashboard の CMS の開き方。原文へのリンクの行き先に使う。 */
  readonly cmsView: SiteCmsView;
  /** サイトの公開 URL の origin（Project の site.domains[0]）。サイトの中の画像（"/" から始まる）を表示するのに使う。 */
  readonly siteOrigin: string | null;
  /** URL の `/translations/<itemKey>`。最初の表示だけに使う（開き直すときはホストが key を替える）。 */
  readonly route: ProjectTranslationsRoute | null;
  /** 一覧・1 件・設定を移ったとき。ホストが URL を合わせる。 */
  readonly onNavigate: (state: LocalizationNavigationState) => void;
};

export function KamakuraLocalizationWorkspace({ cmsView, siteOrigin, route, onNavigate }: KamakuraLocalizationWorkspaceProps) {
  const itemKey = route?.itemKey ?? null;
  return <LocalizationWorkspace adapter={adapterFor(cmsView, siteOrigin)} onNavigate={onNavigate} {...(itemKey === null ? {} : { initialItemKey: itemKey })} />;
}

/** CMS の同じ項目画面内で開く訳文。翻訳一覧は読み込まない。 */
export function KamakuraCmsTranslation({ siteOrigin, itemKey, onBack, registerBack }: { readonly siteOrigin: string | null; readonly itemKey: string; readonly onBack: () => void; readonly registerBack: (back: (() => void) | null) => void }) {
  return <LocalizationItemWorkspace adapter={adapterFor("workspace", siteOrigin)} itemKey={itemKey} onBack={onBack} registerBack={registerBack} />;
}
