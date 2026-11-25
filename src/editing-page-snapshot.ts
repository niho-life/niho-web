import { parseEditorReadOnly } from "./editor-model.js";
import type { EditorSnapshot } from "./editor-types.js";
import { parseEnglishPublication } from "./english-publication.js";
import { parseSitePresentation } from "./presentation.js";
import type { BlockContracts, PageDocument, SitePresentation } from "./types.js";
import { keys, line, record } from "./validation-utils.js";

export const EDITING_EDITOR_SNAPSHOT_ACCEPT = "application/json; profile=niho-editor-snapshot-v1";

export type EditingPageEditorState = Readonly<Pick<EditorSnapshot, "releases" | "readOnly" | "englishPublication">>;

export function parseEditingPageEditorState(input: unknown): EditingPageEditorState {
  const state = record(input, "editorState");
  keys(state, ["releases", "readOnly", "englishPublication"], "editorState");
  const readOnly = parseEditorReadOnly(state.readOnly);
  const englishPublication = state.englishPublication === undefined ? undefined : parseEnglishPublication(state.englishPublication);
  if (state.releases !== undefined && !Array.isArray(state.releases)) throw new Error("invalid editor state");
  const releases = state.releases?.map((input) => {
    const release = record(input, "editorState.releases");
    keys(release, ["revision", "label"], "editorState.releases");
    if (typeof release.revision !== "number" || !Number.isSafeInteger(release.revision) || release.revision < 1) throw new Error("invalid release revision");
    return { revision: release.revision, label: line(release.label, "release.label", 1000) };
  });
  return { ...(readOnly ? { readOnly } : {}), ...(englishPublication ? { englishPublication } : {}), ...(releases ? { releases } : {}) };
}

export function parseEditingPagePresentation(input: unknown, version: unknown, document: PageDocument, blocks?: BlockContracts): SitePresentation | undefined {
  const presentation = input === undefined ? undefined : parseSitePresentation(input, document, blocks);
  if (version !== presentation?.version) throw new Error("presentation version mismatch");
  return presentation;
}
