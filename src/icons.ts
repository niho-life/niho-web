import type { IconName } from "./types.js";

/** 文書が参照できる組み込みアイコン。文字そのものや SVG/HTML は文書から受け取らない。 */
export const iconCatalog: readonly { name: IconName; label: string; glyph: string }[] = Object.freeze([
  { name: "arrow-right", label: "右矢印", glyph: "→" },
  { name: "arrow-left", label: "左矢印", glyph: "←" },
  { name: "check", label: "チェック", glyph: "✓" },
  { name: "close", label: "閉じる", glyph: "×" },
  { name: "plus", label: "追加", glyph: "+" },
  { name: "minus", label: "削除", glyph: "−" },
  { name: "star", label: "星", glyph: "★" },
  { name: "heart", label: "ハート", glyph: "♥" },
  { name: "location", label: "位置", glyph: "◆" },
  { name: "info", label: "情報", glyph: "ⓘ" }
]);

const icons = new Map(iconCatalog.map((entry) => [entry.name, entry] as const));
export const isIconName = (value: unknown): value is IconName => typeof value === "string" && icons.has(value as IconName);
export const iconGlyph = (name: IconName): string => icons.get(name)!.glyph;
