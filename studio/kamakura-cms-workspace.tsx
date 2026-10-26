/**
 * Dashboard の「CMS」（鎌倉）を Studio のコレクション画面（CollectionWorkspace）で開く中身。
 * 本文の編集部品（TipTap）を含んで大きいので、client からは CMS を開いたときだけ import() で読む（studio/site-cms.tsx）。
 */
import type { ReactNode } from "react";
import { CollectionWorkspace, type CollectionAdapter, type CollectionNavigationState, type CollectionRichTextEditorProps } from "../src/collection-workspace.js";
import { createKamakuraCmsAdapter } from "./kamakura-cms.js";
import { KAMAKURA_CMS_PROJECT_ID, KAMAKURA_CMS_SITE_ID } from "./kamakura-cms-contract.js";
import { kamakuraCmsLocalizationItemKey } from "./kamakura-localization-contract.js";
import { projectAliasPath } from "./project-routes.mjs";
import { createStudioRichText } from "./rich-text-editor.js";

type Session = { readonly adapter: CollectionAdapter; readonly renderRichText: (props: CollectionRichTextEditorProps) => ReactNode };
const sessions = new Map<string, Session>();

/**
 * adapter と本文の部品は描画の外でサイトごとに 1 回だけ作る。作り直すと CollectionWorkspace が中身を読み直し、
 * adapter が覚えた version（差分の保存に使う）も失う。
 */
function sessionFor(siteOrigin: string | null): Session {
  const key = siteOrigin ?? "";
  const existing = sessions.get(key);
  if (existing) return existing;
  const adapter = createKamakuraCmsAdapter({ siteOrigin });
  const imageUrl = adapter.imageUrl;
  const session: Session = { adapter, renderRichText: createStudioRichText(imageUrl ? { imageUrl: (url, width) => imageUrl(url, width) } : {}) };
  sessions.set(key, session);
  return session;
}

export type KamakuraCmsWorkspaceProps = {
  /** サイトの公開 URL の origin（Project の site.domains[0]）。プレビューの URL に使う。 */
  readonly siteOrigin: string | null;
  /** URL の `/cms/<collectionId>/<itemId>`。最初の表示だけに使う（開き直すときはホストが key を替える）。 */
  readonly route: CollectionNavigationState | null;
  /** 一覧・項目を移ったとき。ホストが URL を合わせる。 */
  readonly onNavigate: (route: CollectionNavigationState) => void;
};

export function KamakuraCmsWorkspace({ siteOrigin, route, onNavigate }: KamakuraCmsWorkspaceProps) {
  const { adapter, renderRichText } = sessionFor(siteOrigin);
  const initial = route ? { initialCollectionId: route.collectionId, ...(route.itemId === null ? {} : { initialItemId: route.itemId }) } : {};
  return <CollectionWorkspace adapter={adapter} renderRichText={renderRichText} onNavigate={onNavigate}
    itemLanguages={{ source: "日本語", target: "English", targetHref: ({ collectionId, itemId }) => {
      const itemKey = kamakuraCmsLocalizationItemKey(collectionId, itemId);
      return itemKey ? projectAliasPath(KAMAKURA_CMS_PROJECT_ID, KAMAKURA_CMS_SITE_ID, "translations", { itemKey }) : null;
    } }} {...initial} />;
}
