export const API_VERSION = "v1";
export const API_PREFIX = `/api/cli/${API_VERSION}`;
export const SERVICE_CLIENT_ID = /^[0-9a-f]{32}\.access$/u;
export const SCOPE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
export const OPERATION_KEY_HEADER = "X-Studio-Operation-Key";
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function normalizeOperationKey(value) {
  const key = typeof value === "string" ? value.toLowerCase() : "";
  return UUID_V4.test(key) ? key : null;
}

const ARGUMENT = /^[A-Za-z0-9_][A-Za-z0-9._~-]{0,511}$/u;

// Each entry maps one public v1 operation to an existing, separately validated route.
function operation(id, capability, method, bridgePath, options = {}) {
  const parameters = [...bridgePath.matchAll(/:([A-Za-z]+)/gu)].map((match) => match[1]);
  return Object.freeze({ id, capability, method, bridgePath, parameters: Object.freeze(parameters), ...options });
}

export const DRAFT_RECOVERY_MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const DRAFT_RECOVERY_MAX_OUTPUT_BYTES = 7 * 1024 * 1024;

export const OPERATIONS = Object.freeze([
  operation("site.breakpoints.read", "site.settings.read", "GET", "/breakpoints"),
  operation("site.breakpoints.save", "site.settings.write", "PUT", "/breakpoints"),
  operation("site.members.read", "site.members.read", "GET", "/membership"),
  operation("site.members.role", "site.members.manage", "POST", "/members/role"),
  operation("site.members.remove", "site.members.manage", "POST", "/members/remove"),
  operation("site.invitations.create", "site.members.manage", "POST", "/invitations"),
  operation("site.invitations.revoke", "site.members.manage", "POST", "/invitations/revoke"),

  operation("pages.catalog", "pages.read", "GET", "/editor/catalog"),
  operation("pages.read", "pages.read", "GET", "/editor/:pageId"),
  operation("pages.save", "pages.edit", "PUT", "/editor/:pageId/draft"),
  operation("pages.draft-conflict", "pages.edit", "GET", "/editor/:pageId/draft-conflict"),
  operation("pages.draft-resolve", "pages.edit", "PUT", "/editor/:pageId/draft-conflict"),
  operation("pages.release-plan", "pages.publish", "POST", "/editor/:pageId/release-plan"),
  operation("pages.release", "pages.publish", "POST", "/editor/:pageId/release"),
  operation("pages.change-prepare", "pages.publish", "POST", "/editor/page-changes/prepare"),
  operation("pages.change-apply", "pages.publish", "POST", "/editor/page-changes/apply"),
  operation("pages.english-publication-retry", "pages.publish", "POST", "/editor/:pageId/english-publication-retry"),
  operation("pages.embed-status", "pages.read", "POST", "/editor/embeds/:pageId/status"),
  operation("pages.embed-import", "pages.edit", "POST", "/editor/embeds/:pageId/import"),

  operation("cms.schema", "cms.read", "GET", "/cms/schema"),
  operation("cms.list", "cms.read", "GET", "/cms/collections/:collectionId/items"),
  operation("cms.read", "cms.read", "GET", "/cms/collections/:collectionId/items/:itemId"),
  operation("cms.english-publication", "cms.read", "GET", "/cms/collections/:collectionId/items/:itemId/english-publication"),
  operation("cms.english-publication-retry", "cms.publish", "POST", "/cms/collections/:collectionId/items/:itemId/english-publication"),
  operation("cms.create", "cms.edit", "POST", "/cms/collections/:collectionId/items"),
  operation("cms.save", "cms.edit", "PUT", "/cms/collections/:collectionId/items/:itemId/draft"),
  operation("cms.discard-draft", "cms.edit", "POST", "/cms/collections/:collectionId/items/:itemId/discard-draft"),
  operation("cms.duplicate", "cms.edit", "POST", "/cms/collections/:collectionId/items/:itemId/duplicate"),
  operation("cms.publish", "cms.publish", "POST", "/cms/collections/:collectionId/items/:itemId/publish"),
  operation("cms.unpublish", "cms.publish", "POST", "/cms/collections/:collectionId/items/:itemId/unpublish"),
  operation("cms.remove", "cms.publish", "POST", "/cms/collections/:collectionId/items/:itemId/remove"),
  operation("cms.schedule", "cms.publish", "POST", "/cms/collections/:collectionId/items/:itemId/schedule"),
  operation("cms.cancel-schedule", "cms.publish", "POST", "/cms/collections/:collectionId/items/:itemId/cancel-schedule"),
  operation("cms.retry-schedule", "cms.publish", "POST", "/cms/collections/:collectionId/items/:itemId/retry-schedule"),
  operation("cms.reorder", "cms.publish", "POST", "/cms/collections/:collectionId/reorder"),
  operation("cms.bulk", "cms.publish", "POST", "/cms/collections/:collectionId/bulk"),
  operation("cms.upload-intent", "cms.edit", "POST", "/cms/uploads/intent", { upload: "cms" }),

  operation("assets.list", "assets.read", "POST", "/editor/assets/list"),
  operation("assets.usages", "assets.read", "POST", "/editor/assets/usages"),
  operation("assets.resolve", "assets.read", "POST", "/editor/assets/resolve"),
  operation("assets.update", "assets.edit", "POST", "/editor/assets/update"),
  operation("assets.upload-intent", "assets.edit", "POST", "/editor/assets/upload-intent", { upload: "asset" }),

  operation("translations.overview", "translations.read", "POST", "/localization/overview"),
  operation("translations.list", "translations.read", "POST", "/localization/items"),
  operation("translations.list-after", "translations.read", "POST", "/localization/items/after/:cursor"),
  operation("translations.read", "translations.read", "POST", "/localization/items/:itemKey"),
  operation("translations.preview", "translations.read", "POST", "/localization/preview/items"),
  operation("translations.release-history", "translations.read", "POST", "/localization/release"),
  operation("translations.editor-site", "translations.read", "POST", "/localization/editor/site"),
  operation("translations.editor-page", "translations.read", "POST", "/localization/editor/pages/:pageId"),
  operation("translations.editor-snapshot", "translations.read", "POST", "/localization/editor/pages/:pageId/snapshot"),
  operation("translations.catalog-advance", "translations.translate", "POST", "/localization/catalog/advance"),
  operation("translations.request", "translations.translate", "POST", "/localization/items/:itemKey/translate"),
  operation("translations.job", "translations.translate", "POST", "/localization/jobs/:jobId"),
  operation("translations.editor-request", "translations.translate", "POST", "/localization/editor/pages/:pageId/command", { action: "request-translation" }),
  operation("translations.set-value", "translations.edit", "POST", "/localization/items/:itemKey/command", { action: "set-value" }),
  operation("translations.clear-value", "translations.edit", "POST", "/localization/items/:itemKey/command", { action: "clear-value" }),
  operation("translations.adopt-candidate", "translations.edit", "POST", "/localization/items/:itemKey/command", { action: "adopt-candidate" }),
  operation("translations.set-image", "translations.edit", "POST", "/localization/items/:itemKey/command", { action: "set-image" }),
  operation("translations.upload-intent", "translations.edit", "POST", "/localization/uploads/intent", { upload: "localization" }),
  operation("translations.editor-save", "translations.edit", "POST", "/localization/editor/pages/:pageId/save"),
  operation("translations.editor-set-value", "translations.edit", "POST", "/localization/editor/pages/:pageId/command", { action: "set-value" }),
  operation("translations.editor-adopt-candidate", "translations.edit", "POST", "/localization/editor/pages/:pageId/command", { action: "adopt-candidate" }),
  operation("translations.review-current", "translations.review", "POST", "/localization/items/:itemKey/command", { action: "review-current" }),
  operation("translations.review-image", "translations.review", "POST", "/localization/items/:itemKey/command", { action: "review-image" }),
  operation("translations.editor-review-current", "translations.review", "POST", "/localization/editor/pages/:pageId/command", { action: "review-current" }),
  operation("translations.release-state", "translations.publish", "POST", "/localization/release", { releasePending: true }),
  operation("translations.release-prepare", "translations.publish", "POST", "/localization/release/prepare", { owner: true }),
  operation("translations.release-apply", "translations.publish", "POST", "/localization/release/apply", { owner: true }),
  operation("translations.settings", "translations.settings", "PUT", "/localization/settings", { owner: true })
]);

const byId = new Map(OPERATIONS.map((entry) => [entry.id, entry]));

export function resolveOperation(id, args) {
  const spec = byId.get(id);
  if (!spec || args.length !== spec.parameters.length || args.some((value) => !ARGUMENT.test(value))) return null;
  const bridgePath = spec.bridgePath.replace(/:([A-Za-z]+)/gu, (_match, key) => args[spec.parameters.indexOf(key)]);
  return { spec, bridgePath };
}
