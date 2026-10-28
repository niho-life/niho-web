import { normalizeEmbedSource } from "./embeds.js";

type OverlayElement = HTMLElement & { hidden: boolean };
type ScriptSocialProvider = "x" | "instagram";

export type SitePresentationOptions = {
  interactive?: boolean;
  /** trusted host code が所有する、親documentとは別originの固定X投稿frame endpoint。 */
  xPostFrameUrl?: string;
};

function escapeEmbedAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** canonical URLを固定の公式markupへだけ差し込む。文書由来のHTML・script・iframe URLは使わない。 */
function instagramSrcDoc(source: string): string {
  const escaped = escapeEmbedAttribute(source);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><blockquote class="instagram-media" data-instgrm-permalink="${escaped}" data-instgrm-version="14"><a href="${escaped}">Instagramで投稿を見る</a></blockquote><script async src="https://www.instagram.com/embed.js"></script></body></html>`;
}

function trustedXPostFrameEndpoint(value: unknown, ownerDocument: Document): URL | null {
  if (typeof value !== "string") return null;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || value.includes("?") || value.includes("#")) return null;
    if (endpoint.origin === ownerDocument.location.origin) return null;
    return endpoint;
  } catch { return null; }
}

const focusableSelector = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]';

function focusableElements(overlay: HTMLElement): HTMLElement[] {
  return Array.from(overlay.querySelectorAll<HTMLElement>(focusableSelector)).filter(element => {
    if (element.tabIndex < 0) return false;
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (current.hidden || current.getAttribute("aria-hidden") === "true" || style?.display === "none" || style?.visibility === "hidden") return false;
      if (current === overlay) break;
    }
    return true;
  });
}

/** 検証済みdata属性だけを解釈する、公開SSRとeditor preview共通の標準操作runtime。 */
export function initializeSitePresentation(scope: ParentNode = document, options: SitePresentationOptions = {}): () => void {
  const ownerDocument = scope.nodeType === 9 ? scope as Document : (scope as Node).ownerDocument;
  if (!ownerDocument) return () => {};
  const cleanups: Array<() => void> = [], html = ownerDocument.documentElement;
  let openOverlay: OverlayElement | null = null, opener: HTMLElement | null = null, previousOverflow = "", previousGutter = "";
  const listen = (target: EventTarget, type: string, listener: EventListener) => {
    target.addEventListener(type, listener); cleanups.push(() => target.removeEventListener(type, listener));
  };
  const sizedFrames = Array.from(scope.querySelectorAll<HTMLIFrameElement>('iframe[data-nw-frame-key][sandbox="allow-scripts"]')).map((frame) => {
    const key = frame.dataset.nwFrameKey ?? "", maximum = Number(frame.dataset.nwFrameMaxHeight), wrapper = frame.closest<HTMLElement>("[data-nw-host-view]");
    return { frame, key, maximum, wrapper, frameHeight: frame.style.height, wrapperHeight: wrapper?.style.height ?? "" };
  }).filter(({ key, maximum }) => !!key && Number.isInteger(maximum) && maximum >= 200 && maximum <= 4000);
  if (sizedFrames.length && ownerDocument.defaultView) {
    listen(ownerDocument.defaultView, "message", ((event: Event) => {
      const message = event as MessageEvent, value = message.data;
      if (message.origin !== "null" || !value || typeof value !== "object" || Array.isArray(value)) return;
      const data = value as Record<string, unknown>;
      if (Object.keys(data).sort().join(",") !== "frameKey,height,type" || data.type !== "niho-native-frame-size" || typeof data.frameKey !== "string" || typeof data.height !== "number" || !Number.isFinite(data.height) || !Number.isInteger(data.height)) return;
      const binding = sizedFrames.find(({ frame, key }) => key === data.frameKey && message.source === frame.contentWindow);
      if (!binding || data.height < 100 || data.height > binding.maximum) return;
      binding.frame.style.height = `${data.height}px`;
      if (binding.wrapper) binding.wrapper.style.height = `${data.height}px`;
    }) as EventListener);
    cleanups.push(() => sizedFrames.forEach(({ frame, wrapper, frameHeight, wrapperHeight }) => {
      frame.style.height = frameHeight;
      if (wrapper) wrapper.style.height = wrapperHeight;
    }));
    for (const { frame, key } of sizedFrames) {
      const requestSize = () => frame.contentWindow?.postMessage({ type: "niho-native-frame-request-size", frameKey: key }, "*");
      listen(frame, "load", requestSize);
      requestSize();
    }
  }
  // Frame sizing is required while editing too. Navigation and animation are preview-only.
  if (options.interactive === false) return () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
  const lottieSource = /^https:\/\/lottie\.host\/embed\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9_-])?\.(?:json|lottie)$/u;
  const lottieBindings = Array.from(scope.querySelectorAll<HTMLElement>('[data-nw-embed="lottie"][data-nw-lottie-source]')).flatMap((root) => {
    if (root.hasAttribute("data-nw-lottie-static")) return [];
    const source = root.dataset.nwLottieSource ?? "", title = root.dataset.nwLottieTitle ?? "";
    const ViewHTMLElement = ownerDocument.defaultView?.HTMLElement;
    const mount = ViewHTMLElement ? Array.from(root.children).find((child): child is HTMLElement => child instanceof ViewHTMLElement && child.hasAttribute("data-nw-lottie-player")) : undefined;
    return mount && lottieSource.test(source) && title.trim() ? [{ source, title, mount, frame: null as HTMLIFrameElement | null }] : [];
  });
  if (lottieBindings.length) {
    const view = ownerDocument.defaultView, reducedMotion = view?.matchMedia?.("(prefers-reduced-motion: reduce)");
    const renderLottie = () => {
      for (const binding of lottieBindings) {
        if (reducedMotion?.matches) { binding.frame?.remove(); binding.frame = null; continue; }
        if (binding.frame?.isConnected) continue;
        const frame = ownerDocument.createElement("iframe");
        frame.src = binding.source; frame.title = binding.title;
        frame.setAttribute("loading", "lazy"); frame.setAttribute("referrerpolicy", "no-referrer"); frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("aria-hidden", "true"); frame.setAttribute("tabindex", "-1"); frame.setAttribute("data-nw-lottie-frame", "");
        frame.style.gridArea = "1 / 1"; frame.style.width = "100%"; frame.style.height = "100%"; frame.style.border = "0"; frame.style.display = "block"; frame.style.pointerEvents = "none";
        binding.mount.append(frame); binding.frame = frame;
      }
    };
    if (reducedMotion) listen(reducedMotion, "change", renderLottie as EventListener);
    renderLottie();
    cleanups.push(() => lottieBindings.forEach((binding) => { binding.frame?.remove(); binding.frame = null; }));
  }
  const facebookBindings = Array.from(scope.querySelectorAll<HTMLElement>('[data-nw-embed="facebook"][data-nw-facebook-source]')).flatMap((root) => {
    if (root.hasAttribute("data-nw-facebook-static")) return [];
    const source = root.dataset.nwFacebookSource ?? "", title = root.dataset.nwFacebookTitle ?? "";
    const ViewHTMLElement = ownerDocument.defaultView?.HTMLElement;
    const direct = ViewHTMLElement ? Array.from(root.children).filter((child): child is HTMLElement => child instanceof ViewHTMLElement) : [];
    const player = direct.find((child) => child.hasAttribute("data-nw-facebook-player"));
    const mount = ViewHTMLElement && player ? Array.from(player.children).find((child): child is HTMLElement => child instanceof ViewHTMLElement && child.hasAttribute("data-nw-facebook-frame-mount")) : undefined;
    const status = mount?.querySelector<HTMLElement>("[data-nw-facebook-status]");
    const button = player?.querySelector<HTMLButtonElement>("button[data-nw-facebook-load]");
    const link = player?.querySelector<HTMLAnchorElement>("a[data-nw-facebook-link]");
    let canonical = false;
    try { canonical = normalizeEmbedSource("facebook", source) === source; } catch { /* Untrusted or edited runtime attributes stay static. */ }
    return canonical && title.trim() && mount && status && button && link?.getAttribute("href") === source
      ? [{ source, title, mount, status, button, frame: null as HTMLIFrameElement | null }]
      : [];
  });
  for (const binding of facebookBindings) {
    binding.button.hidden = false;
    const activate = () => {
      if (binding.frame?.isConnected) return;
      const plugin = new URL("https://www.facebook.com/plugins/post.php");
      plugin.searchParams.set("href", binding.source);
      const frame = ownerDocument.createElement("iframe");
      frame.src = plugin.href; frame.title = binding.title;
      frame.setAttribute("loading", "lazy"); frame.setAttribute("referrerpolicy", "no-referrer"); frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.setAttribute("data-nw-facebook-frame", "");
      frame.style.gridArea = "1 / 1"; frame.style.width = "100%"; frame.style.height = "100%"; frame.style.border = "0"; frame.style.display = "block";
      if (binding.mount.closest("[data-nw-facebook-canvas]")) frame.style.pointerEvents = "none";
      binding.mount.append(frame); binding.frame = frame; binding.status.style.visibility = "hidden"; binding.button.hidden = true;
    };
    listen(binding.button, "click", activate as EventListener);
  }
  cleanups.push(() => facebookBindings.forEach((binding) => { binding.frame?.remove(); binding.frame = null; binding.status.style.visibility = ""; binding.button.hidden = true; }));
  const xPostFrameEndpoint = trustedXPostFrameEndpoint(options.xPostFrameUrl, ownerDocument);
  const socialProviders: readonly ScriptSocialProvider[] = ["x", "instagram"];
  const socialBindings = socialProviders.flatMap((provider) => Array.from(scope.querySelectorAll<HTMLElement>(`[data-nw-embed="${provider}"][data-nw-social-source]`)).flatMap((root) => {
    if (provider === "x" && !xPostFrameEndpoint) return [];
    if (root.hasAttribute("data-nw-social-static")) return [];
    const source = root.dataset.nwSocialSource ?? "", title = root.dataset.nwSocialTitle ?? "";
    const ViewHTMLElement = ownerDocument.defaultView?.HTMLElement;
    const direct = ViewHTMLElement ? Array.from(root.children).filter((child): child is HTMLElement => child instanceof ViewHTMLElement) : [];
    const player = direct.find((child) => child.hasAttribute("data-nw-social-player"));
    const mount = ViewHTMLElement && player ? Array.from(player.children).find((child): child is HTMLElement => child instanceof ViewHTMLElement && child.hasAttribute("data-nw-social-frame-mount")) : undefined;
    const status = mount?.querySelector<HTMLElement>("[data-nw-social-status]");
    const button = player?.querySelector<HTMLButtonElement>("button[data-nw-social-load]");
    const link = player?.querySelector<HTMLAnchorElement>("a[data-nw-social-link]");
    let canonical = false;
    try { canonical = normalizeEmbedSource(provider, source) === source; } catch { /* Untrusted or edited runtime attributes stay static. */ }
    return canonical && title.trim() && mount && status && button && link?.getAttribute("href") === source
      ? [{ provider, source, title, root, link, mount, status, button, frame: null as HTMLIFrameElement | null, fallback: null as HTMLElement | null }]
      : [];
  }));
  for (const binding of socialBindings) {
    binding.button.hidden = false;
    const activate = () => {
      if (binding.frame?.isConnected) return;
      const currentSource = binding.root.dataset.nwSocialSource ?? "";
      try {
        if (currentSource !== binding.source || normalizeEmbedSource(binding.provider, currentSource) !== currentSource || binding.link.getAttribute("href") !== currentSource) return;
      } catch { return; }
      const frame = ownerDocument.createElement("iframe");
      if (binding.provider === "x") {
        const source = new URL(xPostFrameEndpoint!.href);
        source.searchParams.set("url", binding.source);
        frame.src = source.href;
      } else frame.srcdoc = instagramSrcDoc(binding.source);
      frame.title = binding.title;
      frame.setAttribute("loading", "lazy"); frame.setAttribute("referrerpolicy", "no-referrer"); frame.setAttribute("sandbox", binding.provider === "x" ? "allow-scripts allow-same-origin" : "allow-scripts");
      frame.setAttribute(`data-nw-${binding.provider}-frame`, "");
      frame.style.gridArea = "1 / 1"; frame.style.width = "100%"; frame.style.height = "100%"; frame.style.border = "0"; frame.style.display = "block";
      if (binding.mount.closest("[data-nw-social-canvas]")) frame.style.pointerEvents = "none";
      if (binding.provider === "x") {
        const fallback = ownerDocument.createElement("span");
        fallback.setAttribute("role", "status"); fallback.setAttribute("data-nw-x-fallback", "");
        fallback.textContent = "表示されない場合は元投稿をXで開いてください。";
        binding.link.before(fallback); binding.fallback = fallback;
      }
      binding.mount.append(frame); binding.frame = frame; binding.status.style.visibility = "hidden"; binding.button.hidden = true;
    };
    listen(binding.button, "click", activate as EventListener);
  }
  cleanups.push(() => socialBindings.forEach((binding) => { binding.frame?.remove(); binding.frame = null; binding.fallback?.remove(); binding.fallback = null; binding.status.style.visibility = ""; binding.button.hidden = true; }));
  for (const root of Array.from(scope.querySelectorAll<HTMLElement>("[data-nw-loop-box]"))) {
    const view = ownerDocument.defaultView; if (!view) continue;
    const direct = Array.from(root.children), track = direct.find((child): child is HTMLElement => child instanceof view.HTMLElement && child.hasAttribute("data-nw-loop-box-track"));
    const cloneMount = direct.find((child): child is HTMLElement => child instanceof view.HTMLElement && child.hasAttribute("data-nw-loop-box-clones"));
    const speed = Number(root.dataset.nwLoopSpeed), pauseOnHover = root.dataset.nwLoopPauseHover === "true";
    if (!track || !cloneMount || !Number.isFinite(speed) || speed < 0 || speed > 1000) continue;
    const reducedMotion = view.matchMedia?.("(prefers-reduced-motion: reduce)");
    const rootStyle = root.getAttribute("style"), trackStyle = track.getAttribute("style");
    let animations: Animation[] = [], hoverPaused = false, disposed = false, pendingFrame: number | undefined, pendingTimer: number | undefined;
    const cancelAnimations = () => { const previous = animations; animations = []; previous.forEach((animation) => animation.cancel()); };
    const clearCopies = () => { cancelAnimations(); cloneMount.replaceChildren(); };
    const restoreAttribute = (element: HTMLElement, name: string, value: string | null) => value === null ? element.removeAttribute(name) : element.setAttribute(name, value);
    const inertCopy = (source: HTMLElement): HTMLElement => {
      const references = new Set(["id", "for", "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant"]);
      const resources = new Set(["src", "srcset", "poster", "href", "xlink:href", "data", "action", "formaction", "srcdoc", "autoplay"]);
      // The scoped style selector needs node/owner; runtime markers and slot bindings must not recur.
      const styleScope = new Set(["data-nw-node", "data-nw-owner"]);
      const blockedTags = new Set(["SCRIPT", "STYLE", "LINK", "OBJECT", "EMBED", "META", "BASE"]);
      const clone = (node: Node): Node => {
        if (!(node instanceof view.Element)) return ownerDocument.createTextNode(node.nodeType === 3 ? node.textContent ?? "" : "");
        const original = node, blocked = blockedTags.has(original.tagName) || original.localName.includes("-") || original.namespaceURI !== "http://www.w3.org/1999/xhtml";
        const copy = ownerDocument.createElement(blocked ? "span" : original.localName);
        if (!blocked) for (const attribute of Array.from(original.attributes)) {
          const name = attribute.name.toLowerCase();
          const visualImageSource = (original.tagName === "IMG" && (name === "src" || name === "srcset")) || original.tagName === "SOURCE" && name === "srcset";
          if (name === "style" || references.has(name) || resources.has(name) && !visualImageSource || /^on/iu.test(name) || name.startsWith("data-nw-") && !styleScope.has(name) ||
              name === "name" && original.matches("input,button,select,textarea,fieldset,form")) continue;
          copy.setAttribute(attribute.name, attribute.value);
        }
        if (original instanceof view.HTMLElement) for (const property of Array.from(original.style)) {
          const value = original.style.getPropertyValue(property);
          if (!/url\(|image-set\(|@import/iu.test(value)) copy.style.setProperty(property, value, original.style.getPropertyPriority(property));
        }
        if (["A", "AREA"].includes(original.tagName) || original.matches('button,input,select,textarea,summary,[tabindex],[contenteditable="true"]')) copy.tabIndex = -1;
        copy.removeAttribute("contenteditable");
        if (original.matches("input,button,select,textarea,fieldset")) (copy as HTMLInputElement).disabled = true;
        if (original.tagName === "IMG") copy.setAttribute("loading", "lazy");
        if (["VIDEO", "AUDIO", "IFRAME"].includes(original.tagName)) copy.style.visibility = "hidden";
        if (!blocked) for (const child of Array.from(original.childNodes)) copy.append(clone(child));
        return copy;
      };
      const copy = clone(source) as HTMLElement;
      copy.setAttribute("aria-hidden", "true"); copy.setAttribute("inert", "");
      return copy;
    };
    const rebuild = () => {
      if (disposed) return;
      clearCopies();
      restoreAttribute(root, "style", rootStyle); restoreAttribute(track, "style", trackStyle);
      const computed = view.getComputedStyle(root), direction = ["row", "row-reverse", "column", "column-reverse"].includes(computed.flexDirection) ? computed.flexDirection : "row";
      const vertical = direction.startsWith("column"), reverse = direction.endsWith("reverse");
      root.style.display = "flex"; root.style.flexDirection = direction; root.style.overflow = "hidden";
      track.style.display = "flex"; track.style.flexDirection = direction; track.style.alignItems = computed.alignItems; track.style.gap = computed.gap; track.style.flex = "0 0 auto";
      const rootRect = root.getBoundingClientRect(), trackRect = track.getBoundingClientRect();
      const viewport = vertical ? root.clientHeight || rootRect.height : root.clientWidth || rootRect.width;
      const content = vertical ? trackRect.height : trackRect.width;
      const gapText = vertical ? computed.rowGap : computed.columnGap, gap = Number.parseFloat(gapText) || 0, distance = content + gap;
      if (!(viewport > 0) || !(content > 0) || speed === 0 || reducedMotion?.matches || typeof track.animate !== "function") return;
      const copies = Math.max(2, Math.ceil(viewport / distance) + 2), nodeCount = track.querySelectorAll("*").length + 1;
      // 極端に小さいtrackや巨大な部分木は、不完全なloopを流さず静止fallbackにする。
      if (copies > 32 || copies * nodeCount > 20000) return;
      // column のauto heightがruntime clone分まで伸びないよう、複製前のviewportを固定する。
      if (vertical) root.style.height = `${viewport}px`;
      for (let index = 0; index < copies; index++) cloneMount.append(inertCopy(track));
      const translate = vertical ? `translate3d(0,${reverse ? distance : -distance}px,0)` : `translate3d(${reverse ? distance : -distance}px,0,0)`;
      const duration = Math.max(1, distance / speed * 1000);
      const candidates = [track, ...Array.from(cloneMount.children).filter((child): child is HTMLElement => child instanceof view.HTMLElement)];
      animations = candidates.map((candidate) => candidate.animate([{ transform: "translate3d(0,0,0)" }, { transform: translate }], { duration, iterations: Infinity, easing: "linear" }));
      animations.forEach((animation) => { animation.currentTime = 0; });
      if (hoverPaused) animations.forEach((animation) => animation.pause());
    };
    const queueRebuild = () => {
      if (disposed || pendingFrame !== undefined || pendingTimer !== undefined) return;
      if (typeof view.requestAnimationFrame === "function") pendingFrame = view.requestAnimationFrame(() => { pendingFrame = undefined; rebuild(); });
      else pendingTimer = view.setTimeout(() => { pendingTimer = undefined; rebuild(); }, 0);
    };
    if (pauseOnHover) {
      listen(root, "mouseenter", (() => { hoverPaused = true; animations.forEach((animation) => animation.pause()); }) as EventListener);
      listen(root, "mouseleave", (() => { hoverPaused = false; animations.forEach((animation) => animation.play()); }) as EventListener);
    }
    if (reducedMotion) listen(reducedMotion, "change", queueRebuild as EventListener);
    const ResizeObserverConstructor = view.ResizeObserver;
    if (ResizeObserverConstructor) {
      const observer = new ResizeObserverConstructor(queueRebuild); observer.observe(root); observer.observe(track); cleanups.push(() => observer.disconnect());
    } else listen(view, "resize", queueRebuild as EventListener);
    rebuild();
    cleanups.push(() => {
      disposed = true;
      if (pendingFrame !== undefined) view.cancelAnimationFrame(pendingFrame);
      if (pendingTimer !== undefined) view.clearTimeout(pendingTimer);
      clearCopies(); restoreAttribute(root, "style", rootStyle); restoreAttribute(track, "style", trackStyle);
    });
  }
  for (const root of Array.from(scope.querySelectorAll<HTMLElement>("[data-nw-video-with-button]"))) {
    const direct = Array.from(root.children), video = direct.find((child): child is HTMLVideoElement => child.tagName === "VIDEO" && child.hasAttribute("data-nw-video"));
    const control = direct.find((child): child is HTMLButtonElement => child.tagName === "BUTTON" && child.hasAttribute("data-nw-video-toggle"));
    if (!video || !control || control.disabled) continue;
    const original = { label: control.getAttribute("aria-label"), pressed: control.getAttribute("aria-pressed"), text: control.textContent };
    const pausedLabel = original.label || "動画を再生", pausedText = original.text?.trim() || "再生";
    let active = true;
    const renderVideoState = () => {
      if (!active) return;
      const playing = !video.paused && !video.ended;
      control.setAttribute("aria-label", playing ? "動画を一時停止" : pausedLabel);
      control.setAttribute("aria-pressed", String(playing));
      control.textContent = playing ? "一時停止" : pausedText;
    };
    listen(control, "click", ((event: Event) => {
      event.preventDefault(); event.stopPropagation();
      if (!video.paused && !video.ended) { video.pause(); renderVideoState(); return; }
      try {
        const result = video.play();
        if (result && typeof result.catch === "function") void result.then(renderVideoState, renderVideoState);
        else renderVideoState();
      } catch { renderVideoState(); }
    }) as EventListener);
    for (const type of ["play", "pause", "ended", "emptied", "error"]) listen(video, type, renderVideoState as EventListener);
    renderVideoState();
    cleanups.push(() => {
      active = false;
      if (original.label === null) control.removeAttribute("aria-label"); else control.setAttribute("aria-label", original.label);
      if (original.pressed === null) control.removeAttribute("aria-pressed"); else control.setAttribute("aria-pressed", original.pressed);
      control.textContent = original.text;
    });
  }
  for (const root of Array.from(scope.querySelectorAll<HTMLElement>("[data-nw-carousel]"))) {
    const id = root.dataset.nwCarousel;
    if (!id) continue;
    const owner = root.closest<HTMLElement>("[data-nw-host-view]");
    const container = owner?.dataset.nwHostView === id ? owner : root;
    const slides = Array.from(container.querySelectorAll<HTMLElement>("[data-nw-carousel-slide]"))
      .sort((left, right) => Number(left.dataset.nwCarouselSlide) - Number(right.dataset.nwCarouselSlide));
    if (slides.length < 2 || slides.some((slide, index) => Number(slide.dataset.nwCarouselSlide) !== index)) continue;
    const previous = Array.from(container.querySelectorAll<HTMLElement>("[data-nw-carousel-previous]"));
    const next = Array.from(container.querySelectorAll<HTMLElement>("[data-nw-carousel-next]"));
    const playPause = Array.from(container.querySelectorAll<HTMLElement>("[data-nw-carousel-play-pause]"));
    const originals = slides.map((slide) => ({ hidden: slide.hidden, ariaHidden: slide.getAttribute("aria-hidden") }));
    const originalPressed = playPause.map((control) => control.getAttribute("aria-pressed"));
    const interval = Number(root.dataset.nwCarouselAutoplay), autoplay = Number.isInteger(interval) && interval >= 1000 && interval <= 60000;
    const fade = Number(root.dataset.nwCarouselFade), fadeMs = Number.isInteger(fade) && fade >= 0 && fade <= 3000 ? fade : 0;
    let animations: Animation[] = [];
    const cancelFade = () => { const previous = animations; animations = []; previous.forEach(animation => animation.cancel()); };
    const loop = root.dataset.nwCarouselLoop !== "false", swipe = root.dataset.nwCarouselSwipe === "true";
    const reducedMotion = ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)");
    let index = 0, timer: number | undefined, hoverPaused = false, focusPaused = false, userPaused = root.dataset.nwCarouselPaused === "true", pointerStart: { id: number; x: number } | null = null;
    const render = () => {
      cancelFade();
      slides.forEach((slide, at) => { slide.hidden = at !== index; slide.setAttribute("aria-hidden", String(at !== index)); });
      playPause.forEach((control) => control.setAttribute("aria-pressed", String(userPaused)));
    };
    const stopTimer = () => { if (timer !== undefined) ownerDocument.defaultView?.clearInterval(timer); timer = undefined; };
    const startTimer = () => {
      stopTimer();
      if (!autoplay || hoverPaused || focusPaused || userPaused || reducedMotion?.matches) return;
      timer = ownerDocument.defaultView?.setInterval(() => move(1), interval);
    };
    const move = (delta: number) => {
      const previous = index, candidate = index + delta;
      index = loop ? (candidate + slides.length) % slides.length : Math.max(0, Math.min(slides.length - 1, candidate));
      render();
      const outgoing = slides[previous]!, incoming = slides[index]!;
      if (previous !== index && fadeMs > 0 && !reducedMotion?.matches && typeof incoming.animate === "function") {
        outgoing.hidden = false;
        animations = [outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fadeMs, easing: "ease-in-out", fill: "both" }), incoming.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeMs, easing: "ease-in-out", fill: "both" })];
        const active = animations;
        void Promise.all(active.map(animation => animation.finished)).then(() => { if (animations === active) render(); }, () => {});
      }
      startTimer();
    };
    const action = (callback: () => void) => ((event: Event) => { event.preventDefault(); event.stopPropagation(); callback(); }) as EventListener;
    previous.forEach((control) => { listen(control, "click", action(() => move(-1))); listen(control, "keydown", ((event: Event) => { if ((event as KeyboardEvent).code === "Space") action(() => move(-1))(event); }) as EventListener); });
    next.forEach((control) => { listen(control, "click", action(() => move(1))); listen(control, "keydown", ((event: Event) => { if ((event as KeyboardEvent).code === "Space") action(() => move(1))(event); }) as EventListener); });
    playPause.forEach((control) => {
      const toggle = () => { userPaused = !userPaused; render(); startTimer(); };
      listen(control, "click", action(toggle));
      listen(control, "keydown", ((event: Event) => { if ((event as KeyboardEvent).code === "Space") action(toggle)(event); }) as EventListener);
    });
    listen(container, "mouseenter", (() => { hoverPaused = true; stopTimer(); }) as EventListener);
    listen(container, "mouseleave", (() => { hoverPaused = false; startTimer(); }) as EventListener);
    listen(container, "focusin", (() => { focusPaused = true; stopTimer(); }) as EventListener);
    listen(container, "focusout", ((event: Event) => { if (!container.contains((event as FocusEvent).relatedTarget as Node | null)) { focusPaused = false; startTimer(); } }) as EventListener);
    if (reducedMotion) listen(reducedMotion, "change", (() => { render(); startTimer(); }) as EventListener);
    if (swipe) {
      listen(root, "pointerdown", ((event: Event) => { const pointer = event as PointerEvent; if (pointer.isPrimary) pointerStart = { id: pointer.pointerId, x: pointer.clientX }; }) as EventListener);
      listen(root, "pointerup", ((event: Event) => { const pointer = event as PointerEvent, start = pointerStart; pointerStart = null; if (!start || start.id !== pointer.pointerId) return; const distance = pointer.clientX - start.x; if (Math.abs(distance) >= 40) move(distance > 0 ? -1 : 1); }) as EventListener);
      listen(root, "pointercancel", (() => { pointerStart = null; }) as EventListener);
    }
    render(); startTimer();
    cleanups.push(() => { stopTimer(); cancelFade(); slides.forEach((slide, at) => { slide.hidden = originals[at]!.hidden; const value = originals[at]!.ariaHidden; if (value === null) slide.removeAttribute("aria-hidden"); else slide.setAttribute("aria-hidden", value); });
      playPause.forEach((control, at) => { const value = originalPressed[at]; if (value === null) control.removeAttribute("aria-pressed"); else control.setAttribute("aria-pressed", value!); }); });
  }
  const controls = (name: "open" | "close", id: string) => Array.from(scope.querySelectorAll<HTMLElement>(`[data-nw-overlay-${name}]`))
    .filter((control) => control.dataset[name === "open" ? "nwOverlayOpen" : "nwOverlayClose"] === id);
  const setExpanded = (id: string, value: boolean) => controls("open", id).forEach((control) => control.setAttribute("aria-expanded", String(value)));
  const close = (restoreFocus = true) => {
    if (!openOverlay) return;
    const closing = openOverlay, returnTarget = opener;
    closing.hidden = true; setExpanded(closing.id, false); html.style.overflow = previousOverflow; html.style.scrollbarGutter = previousGutter;
    openOverlay = null; opener = null;
    if (restoreFocus && returnTarget?.isConnected) returnTarget.focus();
  };
  const open = (overlay: OverlayElement, control: HTMLElement) => {
    if (openOverlay === overlay) return;
    if (openOverlay && openOverlay !== overlay) close(false);
    openOverlay = overlay; opener = control; previousOverflow = html.style.overflow; previousGutter = html.style.scrollbarGutter;
    if (ownerDocument.defaultView && html.clientWidth < ownerDocument.defaultView.innerWidth) html.style.scrollbarGutter = "stable";
    overlay.hidden = false; html.style.overflow = "hidden"; setExpanded(overlay.id, true);
    (focusableElements(overlay)[0] ?? overlay).focus();
  };
  for (const overlay of Array.from(scope.querySelectorAll<OverlayElement>("[data-nw-overlay]"))) {
    if (!overlay.id || overlay.dataset.nwOverlay !== overlay.id) continue;
    if (!overlay.hasAttribute("data-nw-overlay-editing")) overlay.hidden = true;
    for (const control of controls("open", overlay.id)) {
      control.setAttribute("aria-controls", overlay.id); control.setAttribute("aria-expanded", "false");
      listen(control, "click", ((event: Event) => { event.preventDefault(); event.stopPropagation(); open(overlay, control); }) as EventListener);
      listen(control, "keydown", ((event: Event) => { const key = event as KeyboardEvent; if (key.code === "Space") { key.preventDefault(); key.stopPropagation(); open(overlay, control); } }) as EventListener);
    }
    for (const control of controls("close", overlay.id)) {
      listen(control, "click", ((event: Event) => { event.preventDefault(); event.stopPropagation(); close(); }) as EventListener);
      listen(control, "keydown", ((event: Event) => { const key = event as KeyboardEvent; if (key.code === "Space") { key.preventDefault(); key.stopPropagation(); close(); } }) as EventListener);
    }
    listen(overlay, "click", ((event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.("a[href]")) close(event.defaultPrevented);
    }) as EventListener);
  }
  listen(ownerDocument, "keydown", ((event: Event) => {
    const key = event as KeyboardEvent;
    if (!openOverlay) return;
    if (key.key === "Escape") { key.preventDefault(); close(); return; }
    if (key.key !== "Tab") return;
    const focusable = focusableElements(openOverlay);
    const first = focusable[0], last = focusable.at(-1);
    if (!first || !last) { key.preventDefault(); openOverlay.focus(); return; }
    const outside = !openOverlay.contains(ownerDocument.activeElement);
    if (key.shiftKey && (ownerDocument.activeElement === first || outside)) { key.preventDefault(); last.focus(); }
    else if (!key.shiftKey && (ownerDocument.activeElement === last || outside)) { key.preventDefault(); first.focus(); }
  }) as EventListener);
  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    close(false);
    openOverlay = null; opener = null;
  };
}
