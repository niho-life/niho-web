import type { LocalizationValue } from "./localization-types.js";
import { fail, keys, line, record } from "./validation-utils.js";

/**
 * サイト（プロジェクト）ごとの語彙。原文の語 → 訳語。
 * 翻訳に渡す「ヒント」で、守らせる仕組みではない。誤訳は人があとで確認して直す前提（2026-11-12 の方針）。
 * 保存・編集・翻訳サービスへの送信はホストの責務で、ここは検証と、翻訳の材料に添える文字列を作るだけ。
 */
export type GlossaryEntry = { source: string; target: string };

export const GLOSSARY_LIMITS = {
  /** 1 サイトの語彙の最大件数。 */
  entries: 200,
  /** 原文の語・訳語それぞれの最大文字数。 */
  text: 120,
  /** 1 つの単位に添える語彙の最大件数。 */
  hints: 20,
  /** 1 つの単位に添える文字列の最大文字数（context が長くなりすぎないように）。 */
  hintLength: 400,
} as const;

/** 語彙を検証して、前後の空白を除いた写しを返す。原文の語の重複（大文字小文字を区別しない）は拒否する。 */
export function parseGlossaryEntries(input: unknown, path = "$glossary"): GlossaryEntry[] {
  if (!Array.isArray(input) || input.length > GLOSSARY_LIMITS.entries) fail(path, "expected a glossary array");
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const at = `${path}[${index}]`, value = record(raw, at);
    keys(value, ["source", "target"], at);
    const source = line(value.source, `${at}.source`, GLOSSARY_LIMITS.text).trim();
    const target = line(value.target, `${at}.target`, GLOSSARY_LIMITS.text).trim();
    const key = source.toLowerCase();
    if (seen.has(key)) fail(`${at}.source`, "duplicate glossary source");
    seen.add(key);
    return { source, target };
  });
}

/** 語彙の版。中身（順序に依らない）のハッシュなので、手で上げなくてよい。空の語彙も版を持つ。 */
export async function glossaryVersion(entriesInput: unknown): Promise<string> {
  const entries = parseGlossaryEntries(entriesInput);
  const canonical = JSON.stringify(entries.map((entry) => [entry.source, entry.target]).sort((left, right) => (left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `glossary-${Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function plainText(value: LocalizationValue): string {
  if (typeof value === "string") return value;
  if (value.kind !== "rich-text") return "";
  const visit = (nodes: typeof value.children): string => nodes.map((node) => (node.type === "text" ? node.text : visit(node.children))).join("");
  return visit(value.children);
}

/**
 * その単位の原文に含まれる語だけを選び、翻訳の材料（context）に添える文字列を返す。含まれる語が無ければ空文字。
 * 照合は部分一致で、大文字小文字を区別しない。件数と長さには上限がある（先に並んだ語を優先）。
 */
export function glossaryHintForUnit(entriesInput: readonly GlossaryEntry[], sourceValue: LocalizationValue): string {
  const text = plainText(sourceValue).toLowerCase();
  if (!text || !entriesInput.length) return "";
  const prefix = "Glossary (use these translations): ";
  const pairs: string[] = [];
  let length = prefix.length;
  for (const entry of entriesInput) {
    if (pairs.length >= GLOSSARY_LIMITS.hints) break;
    if (!entry.source || !text.includes(entry.source.toLowerCase())) continue;
    const pair = `${entry.source} → ${entry.target}`;
    if (length + pair.length + (pairs.length ? 2 : 0) > GLOSSARY_LIMITS.hintLength) break;
    length += pair.length + (pairs.length ? 2 : 0);
    pairs.push(pair);
  }
  return pairs.length ? `${prefix}${pairs.join("; ")}` : "";
}

type HintableUnit = { translatable: boolean; sourceValue: LocalizationValue; context: string };

/**
 * 翻訳を依頼するときに、語彙を含む単位の context に語彙を添えた写しを返す。元の単位は変えない
 * （保存する単位・原文の指紋は今までどおり。添えるのは依頼用の複製だけ）。語彙を含まない単位は同じオブジェクトのまま。
 */
export function withGlossaryContext<T extends HintableUnit>(units: readonly T[], entries: readonly GlossaryEntry[]): T[] {
  if (!entries.length) return [...units];
  return units.map((unit) => {
    if (!unit.translatable) return unit;
    const hint = glossaryHintForUnit(entries, unit.sourceValue);
    return hint ? { ...unit, context: `${unit.context} | ${hint}` } : unit;
  });
}
