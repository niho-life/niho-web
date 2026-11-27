export const MANAGED_CMS_EXTRA_OPERATIONS = {
  "cms.items.create": "cms.edit", "cms.items.list": "cms.read", "cms.items.read": "cms.read",
  "cms.preview.prepare": "cms.read", "cms.preview.read": "cms.read",
  "cms.release.current": "cms.read", "cms.release.snapshot": "cms.read"
} as const;
