import { validatePagePath } from "./pages.js";
import type { PageDocument, PageNode } from "./types.js";

/** trusted host が完了先候補として渡すページの、安全判定に必要な部分。 */
export type FormCompletionPageCandidate = {
  siteId: string;
  pageId: string;
  locale: string;
  title: string;
  path?: string;
  kind?: "page" | "template" | "shared";
  visibility?: "public" | "private";
  published?: boolean;
};

type FormCompletionTarget = { siteId: string; pageId: string; locale: string };
const identifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;

/** 候補一覧の値を信用せず、現在のページに対して安全な完了先だけへ絞る。重複 ID は曖昧なので全て除く。 */
export function eligibleFormCompletionPages(candidates: readonly FormCompletionPageCandidate[], target: FormCompletionTarget): FormCompletionPageCandidate[] {
  if (!Array.isArray(candidates)) return [];
  const counts = new Map<string, number>();
  for (const candidate of candidates) if (candidate && typeof candidate === "object" && candidate.siteId === target.siteId && candidate.locale === target.locale && typeof candidate.pageId === "string") {
    counts.set(candidate.pageId, (counts.get(candidate.pageId) ?? 0) + 1);
  }
  const eligible = candidates.filter((candidate) => !!candidate && typeof candidate === "object" &&
    candidate.siteId === target.siteId && candidate.locale === target.locale && candidate.pageId !== target.pageId && identifierPattern.test(candidate.pageId) &&
    candidate.kind === "page" && candidate.visibility === "public" && candidate.published === true &&
    typeof candidate.title === "string" && !!candidate.title.trim() && candidate.title.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(candidate.title) &&
    validatePagePath(candidate.path) === null);
  return eligible.filter((page) => counts.get(page.pageId) === 1);
}

function findNode(nodes: readonly PageNode[], id: string): PageNode | undefined {
  for (const node of nodes) {
    if (node.type !== "text" && node.id === id) return node;
    if (node.type === "element") {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * 検証済み文書の form と、その時点の trusted 候補一覧から安全な完了先を解決する。
 * 候補の削除・非公開化・未公開化・パス変更は呼出しごとに再検証し、解決不能なら null を返す。
 */
export function resolveFormCompletionPath(document: PageDocument, formNodeId: string, candidates: readonly FormCompletionPageCandidate[]): string | null {
  if (!identifierPattern.test(formNodeId)) return null;
  const form = findNode(document.body, formNodeId);
  if (form?.type !== "element" || form.tag !== "form" || !form.formCompletionPageId) return null;
  const matches = eligibleFormCompletionPages(candidates, document).filter((candidate) => candidate.pageId === form.formCompletionPageId);
  return matches.length === 1 ? matches[0]!.path! : null;
}
