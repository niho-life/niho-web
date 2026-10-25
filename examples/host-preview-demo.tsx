import { createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import { PageEditor, type EditorAdapter, type EditorBlockRegistry, type EditorCanvasPreviewProps } from "@niho/web/editor";
import { PageRenderer, SitePageRenderer } from "@niho/web/react";
import { parsePageDocument, type PageDocument, type PublicPropValue } from "@niho/web/core";
import fixture from "./page.json";

// ホストの表示部品（営業日カレンダー・記事一覧）を PageEditor の同じ iframe へ差し込む最小の動作例。
// 公開可能なインメモリ adapter と合成データだけを使い、認証・API・予約には接続しない。

/** ホストが所有する公開表示データ。実サイトでは CMS の JSON や営業日の一覧を、ホストの Client Component が表示部品と同じ版で供給する。 */
type HostDisplayData = { events: readonly { day: number; title: string }[]; articles: readonly { title: string; summary: string }[] };
const HostDisplayData = createContext<HostDisplayData>({ events: [], articles: [] });
/** キャンバスの幅と表示モード。表示部品は block の props を増やさず、context から読む。 */
const CanvasFrame = createContext<{ width: number; mode: EditorCanvasPreviewProps["mode"] }>({ width: 1280, mode: "edit" });
const displayData: HostDisplayData = {
  events: [{ day: 3, title: "朝市" }, { day: 12, title: "海辺のヨガ" }, { day: 20, title: "持ち寄りごはん" }, { day: 27, title: "見学会" }],
  articles: [{ title: "海のそばで働く一週間", summary: "コワーキングの使い方と、昼休みの浜辺の過ごし方。" }, { title: "長屋の台所を直した話", summary: "みんなで使う台所をどう直したか。" }, { title: "冬の鎌倉の楽しみ", summary: "静かな季節の散歩道。" }]
};

/** 営業日カレンダー。公開ページと同じ表示部品で、幅 768px 以上は 7 列、未満は一覧で描く。 */
function EventCalendarDisplay({ heading }: Record<string, PublicPropValue>) {
  const { events } = useContext(HostDisplayData), { width } = useContext(CanvasFrame);
  const days = Array.from({ length: 30 }, (_, index) => index + 1);
  return <section className="host-calendar" aria-label={String(heading)}>
    <h2>{String(heading)}</h2>
    {width >= 768
      ? <ol className="host-calendar-grid">{days.map((day) => { const event = events.find((entry) => entry.day === day); return <li key={day} data-nw-slot="day" className={event ? "has-event" : ""}><span>{day}</span>{event && <small>{event.title}</small>}</li>; })}</ol>
      : <ul className="host-calendar-list">{events.map((event) => <li key={event.day} data-nw-slot="day"><strong>{event.day}日</strong> {event.title}</li>)}</ul>}
  </section>;
}
/** 記事一覧。CMS の公開 JSON を context から読む。 */
function ArticleListDisplay({ heading }: Record<string, PublicPropValue>) {
  const { articles } = useContext(HostDisplayData);
  return <section className="host-articles"><h2>{String(heading)}</h2><ul>{articles.map((article) => <li key={article.title}><h3 data-nw-slot="title">{article.title}</h3><p>{article.summary}</p></li>)}</ul></section>;
}

/** 一般のエディターホストが登録する契約と見本。previewComponent を渡さないホストは、この見本をキャンバスで見る。 */
const sampleBlocks: EditorBlockRegistry = {
  EventCalendar: {
    label: "営業日カレンダー", props: { heading: { type: "string", required: true, maxLength: 80 } }, defaultProps: { heading: "今月の営業日" },
    slots: { day: { label: "日付のセル", style: ["backgroundColor", "color", "borderRadius"] } },
    component: ({ heading }) => <section className="host-calendar"><h2>{String(heading)}</h2><ul className="host-calendar-list">{[3, 12, 20].map((day) => <li key={day} data-nw-slot="day"><strong>{day}日</strong> 見本の予定</li>)}</ul></section>
  },
  ArticleList: {
    label: "記事一覧", props: { heading: { type: "string", required: true, maxLength: 80 } }, defaultProps: { heading: "新しい記事" },
    slots: { title: { label: "記事の見出し", style: ["color", "fontSize", "fontWeight"] } },
    component: ({ heading }) => <section className="host-articles"><h2>{String(heading)}</h2><ul>{["見本の記事 1", "見本の記事 2", "見本の記事 3"].map((title) => <li key={title}><h3 data-nw-slot="title">{title}</h3><p>見本の要約です。</p></li>)}</ul></section>
  }
};

/** 表示部品と同じ版の CSS。ホスト画面の CSS は iframe へ自動では入らないため、部品の中で供給する。 */
const hostCss = ".host-calendar,.host-articles{font-family:sans-serif;margin:24px 0}.host-calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px;list-style:none;padding:0;margin:0}.host-calendar-grid li{min-height:56px;padding:6px;border:1px solid #d7e2d9;border-radius:6px;font-size:13px}.host-calendar-grid li.has-event{background:#e3f2e9}.host-calendar-grid small{display:block;font-size:11px;color:#2d5a43}.host-calendar-list,.host-articles ul{list-style:none;padding:0;margin:0;display:grid;gap:8px}.host-articles h3{margin:0 0 4px;font-size:16px}.host-articles p{margin:0;color:#4a5a50}";

/** ホストの表示部品。所有しないサイトの文書は従来の描画（children）のまま返し、自分のサイトは見本を公開と同じ部品へ差し替えて描き直す。 */
function HostPreview({ document, blocks, assets, presentation, externalFramePolicy, width, mode, children }: EditorCanvasPreviewProps) {
  if (document.siteId !== site.id) return <>{children}</>;
  const display = { ...blocks, EventCalendar: { ...blocks.EventCalendar!, component: EventCalendarDisplay }, ArticleList: { ...blocks.ArticleList!, component: ArticleListDisplay } };
  return <CanvasFrame.Provider value={{ width, mode }}>
    <style>{hostCss}</style>
    {presentation
      ? <SitePageRenderer document={document} presentation={presentation} blocks={display} assets={assets} missingAssets="placeholder" hostViewMode="fallback" {...(externalFramePolicy ? { externalFramePolicy } : {})} />
      : <PageRenderer document={document} blocks={display} assets={assets} missingAssets="placeholder" />}
  </CanvasFrame.Provider>;
}

const site = { id: "demo", name: "動作例のサイト", domains: ["https://demo.example.test"] };
const home = parsePageDocument({ ...(fixture as PageDocument), body: [...(fixture as PageDocument).body,
  { type: "component", id: "calendar", block: "EventCalendar", props: { heading: "今月の営業日" }, style: { base: { marginTop: 32 } } },
  { type: "component", id: "articles", block: "ArticleList", props: { heading: "新しい記事" } }] }, sampleBlocks);
let stored = home, version = 1;
const adapter: EditorAdapter = {
  listSites: async () => [site],
  listPages: async () => [{ siteId: site.id, pageId: stored.pageId, locale: stored.locale, title: stored.title, path: "/" }],
  readDocument: async () => ({ document: structuredClone(stored), version: `memory-${version}` }),
  saveDraft: async (request) => {
    if (request.expectedVersion !== `memory-${version}`) return { status: "conflict" };
    stored = { ...parsePageDocument(request.document, sampleBlocks), revision: stored.revision + 1 }; version++;
    return { status: "saved", version: `memory-${version}`, revision: stored.revision };
  },
  prepareRelease: async () => { throw new Error("この動作例では公開しません。"); },
  release: async () => { throw new Error("この動作例では公開しません。"); }
};

createRoot(document.getElementById("root")!).render(
  <HostDisplayData.Provider value={displayData}><PageEditor adapter={adapter} blocks={sampleBlocks} previewComponent={HostPreview} /></HostDisplayData.Provider>
);
export { adapter as hostPreviewDemoAdapter, sampleBlocks as hostPreviewDemoBlocks };
