import { MANAGED_EMBED_REF, nihoEmbedTarget } from "./managed-embed-contract.js";

function checkoutUrl(value: unknown, nihoOrigin: string): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (url.origin === nihoOrigin && /^(?:\/billing\/|\/living\/)/u.test(url.pathname)) return url.href;
    const allowed = ["checkout.stripe.com", "square.link", "squareup.com", "square.site"];
    return allowed.some((host) => url.hostname === host || host !== "checkout.stripe.com" && url.hostname.endsWith("." + host))
      ? url.href : undefined;
  } catch { return undefined; }
}

export async function initializePublicNihoEmbeds(root: Document, viewer: Window): Promise<void> {
  const frames: { element: HTMLIFrameElement; origin: string; flow: string; submitted: boolean }[] = [];
  const english = root.documentElement.lang.toLowerCase().split("-")[0] === "en";
  viewer.addEventListener("message", (event: MessageEvent<unknown>) => {
    const frame = frames.find(({ origin, element }) => event.origin === origin && event.source === element.contentWindow);
    if (!frame || !event.data || typeof event.data !== "object") return;
    const { type, height, url } = event.data as Record<string, unknown>;
    if (type === "niho-embed-resize" && typeof height === "number" && Number.isFinite(height) && height > 0) {
      const heightPx = Math.max(240, Math.min(6000, Math.ceil(height)));
      frame.element.style.height = `${heightPx}px`;
      if (frame.element.parentElement) frame.element.parentElement.style.minHeight = `${heightPx}px`;
    }
    if (type === "niho-embed-submitted" && !frame.submitted) {
      frame.submitted = true;
      const gtag: unknown = (viewer as Window & { gtag?: unknown }).gtag;
      if (typeof gtag === "function") gtag("event", "generate_lead", { flow: frame.flow });
    }
    if (type === "niho-checkout") {
      const destination = checkoutUrl(url, frame.origin);
      if (destination) viewer.location.assign(destination);
    }
  });
  const parentHref = viewer.location.origin + viewer.location.pathname;
  await Promise.all(Array.from(root.querySelectorAll<HTMLElement>("[data-managed-embed-ref]"), async (container) => {
    const ref = container.dataset.managedEmbedRef;
    const status = container.querySelector("[data-managed-embed-status]");
    if (!ref || !MANAGED_EMBED_REF.test(ref)) return;
    try {
      const endpoint = new URL(parentHref);
      endpoint.searchParams.set("_niho_embed", ref);
      const response = await viewer.fetch(endpoint.href, { credentials: "omit", redirect: "error", cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok || !response.headers.get("Content-Type")?.startsWith("application/json")) throw new Error();
      const value = await response.json() as { src?: unknown } | null;
      const target = typeof value?.src === "string" ? nihoEmbedTarget(value.src) : null;
      if (!target || target.url.origin === viewer.location.origin || !target.url.searchParams.has("launchToken")) throw new Error();
      const { url, flow } = target;
      url.searchParams.set("parentHref", parentHref);
      if (english) url.searchParams.set("lang", "en");
      const transparent = container.dataset.managedEmbedBackground === "transparent";
      if (transparent) url.searchParams.set("bg", "transparent");
      else url.searchParams.delete("bg");
      const frame = root.createElement("iframe");
      const titles = english ? { rental: "Private rental", dropin: "Trial visit", inquiry: "Contact form" }
        : { rental: "貸切利用", dropin: "お試し利用の予約", inquiry: "お問い合わせ" };
      frame.title = titles[flow as keyof typeof titles];
      frame.loading = "lazy";
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      frame.style.cssText = `width:100%;display:block;border:0;background:${transparent ? "transparent" : "white"}`;
      const height = Number(container.dataset.managedEmbedHeight);
      frame.style.height = `${Number.isFinite(height) ? Math.min(1600, Math.max(240, height)) : 720}px`;
      frame.src = url.href;
      frames.push({ element: frame, origin: url.origin, flow, submitted: false });
      container.prepend(frame);
      status?.remove();
    } catch {
      if (status) status.textContent = english ? "The form is unavailable." : "フォームを読み込めませんでした。";
    }
  }));
}

if (typeof document !== "undefined" && typeof window !== "undefined") void initializePublicNihoEmbeds(document, window);
