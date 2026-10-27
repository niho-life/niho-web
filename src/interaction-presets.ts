import type { ElementNode } from "./types.js";

/** JS を使わない安全なインタラクション部品。返すのは文書の検証を通る新しい部分木だけ。 */
export type IdFactory = () => string;
const text = (id: string, tag: "p" | "summary", value: string): ElementNode => ({ type: "element", id, tag, children: [{ type: "text", text: value }] });

/** 横スクロールで切り替える。容器はキーボードで届くよう tabIndex 0 と名前を持つ。 */
export function carouselPreset(id: IdFactory): ElementNode {
  return {
    type: "element", id: id(), tag: "div", attrs: { role: "region", "aria-label": "カルーセル", tabIndex: 0 },
    style: { base: { display: "flex", gap: 16, overflowX: "auto", scrollSnapType: "x mandatory", paddingBottom: 8 } },
    children: [1, 2, 3].map((index): ElementNode => ({
      type: "element", id: id(), tag: "div",
      style: { base: { flexBasis: "80%", flexShrink: 0, scrollSnapAlign: "start", padding: 24, borderRadius: 8, backgroundColor: "#f2f2f2" } },
      children: [text(id(), "p", `スライド ${index}`)]
    }))
  };
}
/** details / summary の開閉。初期は閉じていて、見出しを押すと開く。 */
export function togglePreset(id: IdFactory): ElementNode {
  return {
    type: "element", id: id(), tag: "details", style: { base: { borderWidth: 1, borderStyle: "solid", borderColor: "#e3e3e3", borderRadius: 8, padding: 16 } },
    children: [text(id(), "summary", "開閉する見出し"), text(id(), "p", "開いたときに表示する内容です。")]
  };
}

/** video と重なる再生ボタン。binding は親の閉じた descriptor と固定された直下構造だけで表す。 */
export function videoWithButtonPreset(id: IdFactory): ElementNode {
  return {
    type: "element", id: id(), tag: "div", interaction: { type: "video-toggle" },
    style: { base: { position: "relative", width: "100%", minHeight: 240, overflow: "hidden", backgroundColor: "#111111" } },
    children: [
      {
        type: "element", id: id(), tag: "video",
        attrs: { "aria-label": "動画", controls: true, preload: "metadata", playsInline: true },
        style: { base: { display: "block", width: "100%", height: "100%", minHeight: 240, objectFit: "cover" } }, children: []
      },
      {
        type: "element", id: id(), tag: "button", attrs: { type: "button", "aria-label": "動画を再生", "aria-pressed": "false" },
        style: { base: { position: "absolute", right: 16, bottom: 16, zIndex: 1, width: 52, height: 52, padding: 0, borderWidth: 0, borderRadius: 999, backgroundColor: "#ffffff", color: "#111111", fontSize: 14, fontWeight: 700 } },
        children: [{ type: "text", text: "再生" }]
      }
    ]
  };
}

/** 編集可能な3枚のカードを、flexDirection に沿って流す安全な Loop Box。 */
export function loopBoxPreset(id: IdFactory): ElementNode {
  const cards = ["新しい景色", "心地よい時間", "つながる場所"];
  return {
    type: "element", id: id(), tag: "div", interaction: { type: "loop-box", speed: 60, pauseOnHover: true },
    style: { base: { display: "flex", flexDirection: "row", gap: 16, width: "100%", overflow: "hidden" } },
    children: cards.map((value): ElementNode => ({
      type: "element", id: id(), tag: "div",
      style: { base: { flexShrink: 0, minWidth: 180, padding: 20, borderWidth: 1, borderStyle: "solid", borderColor: "#dedede", borderRadius: 12, backgroundColor: "#f7f7f7" } },
      children: [{ type: "element", id: id(), tag: "p", children: [{ type: "text", text: value }] }]
    }))
  };
}
