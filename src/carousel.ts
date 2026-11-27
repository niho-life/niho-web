import type { CarouselBinding, ElementNode, SitePresentationCarousel } from "./types.js";
import { fail, identifier, keys, record } from "./validation-utils.js";

export const CAROUSEL_SLIDE_LIMIT = 64;
export const CAROUSEL_CONTROL_LIMIT = 16;

export function parseCarousel(input: unknown, nodes: ReadonlyMap<string, ElementNode>, path: string): SitePresentationCarousel | undefined {
  if (input === undefined) return undefined;
  const source = record(input, path);
  const { rootId: inputId, ...binding } = source;
  const rootId = identifier(inputId, `${path}.rootId`);
  if (!nodes.has(rootId)) fail(`${path}.rootId`, "carousel root not found");
  const result = parseCarouselBinding(binding, nodes, path);
  if (carouselNodeIds(result).includes(rootId)) fail(path, "carousel bindings overlap");
  return { rootId, ...result };
}

export function carouselNodeIds(binding: CarouselBinding): string[] {
  return [...binding.slideIds, ...(binding.previousIds ?? []), ...(binding.nextIds ?? []), ...(binding.playPauseIds ?? [])];
}

export function remapCarouselBinding(binding: CarouselBinding, rename: (id: string) => string): CarouselBinding {
  return { ...binding, slideIds: binding.slideIds.map(rename),
    ...(binding.previousIds && { previousIds: binding.previousIds.map(rename) }),
    ...(binding.nextIds && { nextIds: binding.nextIds.map(rename) }),
    ...(binding.playPauseIds && { playPauseIds: binding.playPauseIds.map(rename) }) };
}

export function parseCarouselBinding(input: unknown, nodes: ReadonlyMap<string, ElementNode> | undefined, path: string): CarouselBinding {
  const source = record(input, path);
  keys(source, ["slideIds", "previousIds", "nextIds", "playPauseIds", "autoplayMs", "fadeMs", "initiallyPlaying", "loop", "swipe"], path);
  const readIds = (value: unknown, name: "slideIds" | "previousIds" | "nextIds" | "playPauseIds", required: boolean, limit: number) => {
    const at = `${path}.${name}`;
    if (!Array.isArray(value) || required && value.length < 2 || value.length > limit) fail(at, "invalid carousel bindings");
    const ids = value.map((id, index) => identifier(id, `${at}[${index}]`));
    if (new Set(ids).size !== ids.length || nodes && ids.some((id) => !nodes.has(id))) fail(at, "unknown or duplicate carousel binding");
    return ids;
  };
  const slideIds = readIds(source.slideIds, "slideIds", true, CAROUSEL_SLIDE_LIMIT);
  const previousIds = source.previousIds === undefined ? [] : readIds(source.previousIds, "previousIds", false, CAROUSEL_CONTROL_LIMIT);
  const nextIds = source.nextIds === undefined ? [] : readIds(source.nextIds, "nextIds", false, CAROUSEL_CONTROL_LIMIT);
  const playPauseIds = source.playPauseIds === undefined ? [] : readIds(source.playPauseIds, "playPauseIds", false, CAROUSEL_CONTROL_LIMIT);
  const all = [...slideIds, ...previousIds, ...nextIds, ...playPauseIds];
  if (new Set(all).size !== all.length) fail(path, "carousel bindings overlap");
  if (source.autoplayMs !== undefined && (typeof source.autoplayMs !== "number" || !Number.isInteger(source.autoplayMs) || source.autoplayMs < 1000 || source.autoplayMs > 60000)) fail(`${path}.autoplayMs`, "invalid autoplay interval");
  if (source.fadeMs !== undefined && (typeof source.fadeMs !== "number" || !Number.isInteger(source.fadeMs) || source.fadeMs < 0 || source.fadeMs > 3000)) fail(`${path}.fadeMs`, "invalid fade duration");
  if (source.initiallyPlaying !== undefined && typeof source.initiallyPlaying !== "boolean" || source.loop !== undefined && typeof source.loop !== "boolean" || source.swipe !== undefined && typeof source.swipe !== "boolean") fail(path, "invalid carousel option");
  if (source.initiallyPlaying !== undefined && source.autoplayMs === undefined) fail(`${path}.initiallyPlaying`, "playing state requires an autoplay interval");
  return { slideIds, ...(previousIds.length ? { previousIds } : {}), ...(nextIds.length ? { nextIds } : {}), ...(playPauseIds.length ? { playPauseIds } : {}),
    ...(source.autoplayMs === undefined ? {} : { autoplayMs: source.autoplayMs }), ...(source.fadeMs === undefined ? {} : { fadeMs: source.fadeMs }), ...(source.initiallyPlaying === undefined ? {} : { initiallyPlaying: source.initiallyPlaying }),
    ...(source.loop === undefined ? {} : { loop: source.loop }), ...(source.swipe === undefined ? {} : { swipe: source.swipe }) };
}
