import { isSafePublicUrl } from "./validation-utils.js";

export type ManagedOrganizationSeo = {
  readonly name: string;
  readonly url: string;
  readonly logo: string | null;
  readonly sameAs: readonly string[];
};

export type ManagedSiteSeoSettings = {
  readonly siteName: string | null;
  readonly description: string | null;
  readonly defaultOgImage: string | null;
  readonly verificationTags: readonly { readonly name: string; readonly content: string }[];
  readonly organization: ManagedOrganizationSeo | null;
  readonly robotsPolicy: "index" | "noindex";
  readonly ga4MeasurementId: string | null;
};

export function emptyManagedSiteSeoSettings(): ManagedSiteSeoSettings {
  return { siteName: null, description: null, defaultOgImage: null, verificationTags: [], organization: null, robotsPolicy: "index", ga4MeasurementId: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function optionalLine(value: unknown, max: number): value is string | null {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= max && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function absoluteHttps(value: unknown): value is string {
  if (!isSafePublicUrl(value) || !/^https:\/\//iu.test(value)) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function safeOgImage(value: unknown): value is string | null {
  if (value === null) return true;
  if (!isSafePublicUrl(value) || value.startsWith("#")) return false;
  try { return !new URL(value, "https://seo-settings.invalid").hash; } catch { return false; }
}

export function parseManagedSiteSeoSettings(value: unknown): ManagedSiteSeoSettings | null {
  if (!isRecord(value) || !exactKeys(value, ["siteName", "description", "defaultOgImage", "verificationTags", "organization", "robotsPolicy", "ga4MeasurementId"])) return null;
  const { siteName, description, defaultOgImage, verificationTags, organization, robotsPolicy, ga4MeasurementId } = value;
  if (!optionalLine(siteName, 200) || !optionalLine(description, 500)
    || !safeOgImage(defaultOgImage)
    || robotsPolicy !== "index" && robotsPolicy !== "noindex"
    || ga4MeasurementId !== null && (typeof ga4MeasurementId !== "string" || !/^G-[A-Z0-9]{4,20}$/u.test(ga4MeasurementId))) return null;

  if (!Array.isArray(verificationTags) || verificationTags.length > 12) return null;
  const seenNames = new Set<string>();
  const tags = [] as { name: string; content: string }[];
  for (const tag of verificationTags) {
    if (!isRecord(tag) || !exactKeys(tag, ["name", "content"]) || typeof tag.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/u.test(tag.name)
      || typeof tag.content !== "string" || !tag.content || tag.content.length > 256 || /[\u0000-\u001f\u007f]/u.test(tag.content)
      || seenNames.has(tag.name.toLowerCase())) return null;
    seenNames.add(tag.name.toLowerCase());
    tags.push({ name: tag.name, content: tag.content });
  }

  let parsedOrganization: ManagedOrganizationSeo | null = null;
  if (organization !== null) {
    if (!isRecord(organization) || !exactKeys(organization, ["name", "url", "logo", "sameAs"])
      || !optionalLine(organization.name, 200) || organization.name === null || !absoluteHttps(organization.url)
      || !(organization.logo === null || absoluteHttps(organization.logo))
      || !Array.isArray(organization.sameAs) || organization.sameAs.length > 20 || !organization.sameAs.every(absoluteHttps)
      || new Set(organization.sameAs).size !== organization.sameAs.length) return null;
    parsedOrganization = { name: organization.name, url: organization.url, logo: organization.logo, sameAs: [...organization.sameAs] };
  }

  return { siteName, description, defaultOgImage, verificationTags: tags, organization: parsedOrganization, robotsPolicy, ga4MeasurementId };
}

export function managedVerificationTags(settings: ManagedSiteSeoSettings): string {
  return settings.verificationTags.map(({ name, content }) => `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`).join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
