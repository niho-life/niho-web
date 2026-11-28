export type * from "./types.js";
export { iconCatalog } from "./icons.js";
export {
  createBlankEmbedRegistry, normalizeEmbedSource, parseBlankEmbedRegistry, resolveBlankEmbed,
  type BlankEmbedRegistry, type BlankEmbedRegistryEntry, type BlankEmbedSandboxMode
} from "./embeds.js";
export { parsePageDocument, parsePageDocument as validateDocument, parsePageMeta, type PageParseOptions } from "./document.js";
export { generatePageCss, pageScope, parsePageScope, type PageScopeIdentity } from "./css.js";
export { SITE_PRESENTATION_LIMITS, cssForSitePresentation, parseSitePresentation, presentationAssetDocument, presentationLayoutDocument, sitePresentationHostViewKey } from "./presentation.js";
export { initializeSitePresentation, type SitePresentationOptions } from "./presentation-runtime.js";
export {
  COMPONENT_LIMITS, componentAssetReferences, componentIssues, componentUsage, findComponentLinks, findInstanceLinks, parseComponentLibrary, resolvePageDocument,
  rewriteComponentLinks, rewriteInstanceLinks, type ResolvedOrigin
} from "./components.js";
export { DocumentValidationError, isSafeHttpsOrigin, isSafePublicLink, isSafePublicUrl } from "./validation-utils.js";
export { eligibleFormCompletionPages, resolveFormCompletionPath, type FormCompletionPageCandidate } from "./form-completion.js";
export {
  MOTION_BASE_PROPERTIES, assertMotionStylePatch, createInsertionNode, defineBuilder, layoutInsertionPresets, matchesMotionPreset, motionStylePatch, resolveBuilderDefinition, sameMotionValue, standardBuilderDefinition,
  type BuilderDefinition, type BuilderIdFactory, type InsertionBuildOptions, type InsertionContext, type InsertionPreset, type MotionBaseProperty,
  type MotionPreset, type MotionStylePatch, type MotionTargetPath
} from "./builder.js";

export { SITE_FRAME_LIMITS, composeSiteFrame, parseSiteStylesWithFrame } from "./site-frame.js";
export { detachRemovedSiteStyles, mergeSiteStyles, parseSiteStyles, resolvePageStyles, type SiteFrame, type SiteFrameLocale, type SiteStyles, type SiteStylesRevision, type SiteStylesSnapshot } from "./site-styles.js";
export { inspectPageDocument, parsePageInspectQuery, PAGE_INSPECT_LIMITS, PageInspectError, type PageInspectContext, type PageInspectQuery, type PageInspectView } from "./page-inspect.js";
export { lintDocument, lintDocuments, type NormalizationLintCode, type NormalizationLintContext, type NormalizationLintFinding } from "./normalize.js";
