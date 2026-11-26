import { createElement, memo } from "react";
import { editorRendererToken, editorRendererTokenProp } from "./editor-renderer-token.js";
import { PageRenderer, SitePageRenderer, type PageRendererProps, type SitePageRendererProps } from "./react.js";
import type { PageDocument, SitePresentation } from "./types.js";

type EditorPageRendererProps = PageRendererProps & { document: PageDocument };
type EditorSitePageRendererProps = SitePageRendererProps & { document: PageDocument; presentation: SitePresentation };

function trusted<T extends PageRendererProps>(props: T): T & { [editorRendererTokenProp]: typeof editorRendererToken } {
  return Object.assign({}, props, { [editorRendererTokenProp]: editorRendererToken }) as T & { [editorRendererTokenProp]: typeof editorRendererToken };
}

/** Editor-only renderer. The editor has already parsed this immutable snapshot. */
export const EditorPageRenderer = memo((props: EditorPageRendererProps) => createElement(PageRenderer, trusted(props)));

/** Editor-only native composition. Both the page and presentation came from the validated editor snapshot. */
export const EditorSitePageRenderer = (props: EditorSitePageRendererProps) => createElement(SitePageRenderer, trusted(props));
