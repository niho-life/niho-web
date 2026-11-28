import { parseAssetListResult, parseAssetProviders, parseAssetUploadResult, parseResolvedAssets, type AssetLibraryAdapter } from "../src/assets.js";

/** Studio 内サイトの画像ライブラリ。素材 API（/api/edit/v2/.../assets.*）を同じ Access 認証で呼ぶ。 */
export function createManagedAssetLibrary(siteId: string): AssetLibraryAdapter {
  const operation = (name: string) => `/api/edit/v2/sites/${encodeURIComponent(siteId)}/operations/${name}`;
  const assertSite = (value: string) => { if (value !== siteId) throw new Error("別サイトの素材は参照できません。"); };
  const json = async (response: Response): Promise<unknown> => {
    if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new Error("素材 API の応答が正しくありません。");
    return await response.json() as unknown;
  };
  const list = async (body: Record<string, unknown>, signal: AbortSignal) => {
    const response = await fetch(operation("assets.list"), {
      method: "POST", signal, cache: "no-store", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const value = await json(response);
    if (!response.ok || !value || typeof value !== "object") throw new Error("素材一覧を読み込めませんでした。");
    return value as Record<string, unknown>;
  };
  return {
    // 出所はアップロードと取り込みの2つだけ。ストック・接続のパネルは出さず、1つのパネルで切り替える。
    combinedPanel: true,
    async listAssets(query, signal) {
      assertSite(query.siteId);
      const value = await list({ ...(query.provider === undefined ? {} : { provider: query.provider }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }), limit: Math.min(query.limit, 200) }, signal);
      const { providers: _providers, ...rest } = value;
      const result = parseAssetListResult({ ...rest, folders: [] }, siteId);
      const needle = query.search.trim().toLowerCase();
      return { ...result, assets: result.assets.filter((asset) => (query.kind === "all" || asset.kind === query.kind)
        && (!needle || asset.name.toLowerCase().includes(needle))) };
    },
    async uploadAsset(request, signal) {
      assertSite(request.siteId);
      if (request.provider !== undefined && request.provider !== "studio-upload" || request.folderId !== null) return { status: "rejected", reason: "invalid" };
      const response = await fetch(operation("assets.upload"), {
        method: "PUT", signal, cache: "no-store", credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": request.mimeType, "X-Asset-Name": encodeURIComponent(request.name) },
        body: request.file
      });
      const value = await json(response);
      if (response.status === 403) return { status: "rejected", reason: "permission" };
      if (!response.ok && (!value || typeof value !== "object" || (value as { status?: unknown }).status !== "rejected")) throw new Error("アップロードに失敗しました。");
      return parseAssetUploadResult(value, siteId);
    },
    // サーバーが宣言する出所（アップロード・取り込み）と、その出所でできること。これがあると、選ぶ画面でもアップロードでき、
    // 変更・削除できない素材ではその操作を出さない。
    async listProviders(request, signal) {
      assertSite(request.siteId);
      return parseAssetProviders((await list({ limit: 1 }, signal)).providers);
    },
    updateAsset: async () => ({ status: "rejected", reason: "permission" }),
    listAssetUsages: async () => [],
    deleteAsset: async () => ({ status: "rejected", reason: "permission" }),
    async resolveAssets(request, signal) {
      assertSite(request.siteId);
      if (!request.references.length) return {};
      const response = await fetch(`/api/edit/v1/sites/${encodeURIComponent(siteId)}/operations/assets.resolve`, {
        method: "POST", signal, cache: "no-store", credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ references: request.references })
      });
      const value = await json(response);
      if (!response.ok || !value || typeof value !== "object") throw new Error("素材を解決できませんでした。");
      return parseResolvedAssets((value as { assets?: unknown }).assets);
    }
  };
}
