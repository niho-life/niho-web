type Draftable = Record<PropertyKey, unknown> | unknown[];
type DraftState = {
  base: Draftable;
  copy?: Draftable;
  proxy: Draftable;
  parent?: DraftState;
  parentKey: PropertyKey | undefined;
  children: Map<PropertyKey, DraftState>;
};

const draftStates = new WeakMap<object, DraftState>();

function isDraftable(value: unknown): value is Draftable {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

function shallowCopy(value: Draftable): Draftable {
  return Array.isArray(value) ? value.slice() : Object.assign(Object.create(Object.getPrototypeOf(value)), value);
}

function ensureCopy(state: DraftState): Draftable {
  if (!state.copy) state.copy = shallowCopy(state.base);
  if (state.parent) {
    const parent = ensureCopy(state.parent);
    const position = Array.isArray(parent) ? parent.indexOf(state.proxy) : -1;
    const key = position >= 0 ? position : state.parentKey!;
    if (Reflect.get(parent, key) !== state.proxy) Reflect.set(parent, key, state.proxy);
  }
  return state.copy;
}

function createDraftState(base: Draftable, parent?: DraftState, parentKey?: PropertyKey): DraftState {
  const target = Array.isArray(base) ? [] : Object.create(Object.getPrototypeOf(base));
  const state: DraftState = { base, proxy: target as Draftable, ...(parent ? { parent } : {}), parentKey, children: new Map() };
  const source = () => state.copy ?? state.base;
  const proxy = new Proxy(target, {
    get(_target, key) {
      const value = Reflect.get(source(), key, state.proxy);
      if (!isDraftable(value)) return value;
      const cached = draftStates.get(value as object);
      if (cached) return cached.proxy;
      const related = state.children.get(key);
      if (related?.base === value) return related.proxy;
      const child = createDraftState(value, state, key);
      state.children.set(key, child);
      return child.proxy;
    },
    set(_target, key, value) {
      const current = Reflect.get(source(), key, state.proxy);
      if (Object.is(current, value)) return true;
      state.children.delete(key);
      return Reflect.set(ensureCopy(state), key, value);
    },
    deleteProperty(_target, key) {
      if (!Reflect.has(source(), key)) return true;
      state.children.delete(key);
      return Reflect.deleteProperty(ensureCopy(state), key);
    },
    defineProperty(_target, key, descriptor) {
      state.children.delete(key);
      return Reflect.defineProperty(ensureCopy(state), key, descriptor);
    },
    has(_target, key) { return Reflect.has(source(), key); },
    ownKeys() { return Reflect.ownKeys(source()); },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(source(), key);
      if (!descriptor) return undefined;
      return { ...descriptor, configurable: Array.isArray(base) && key === "length" ? false : true };
    },
    getPrototypeOf() { return Object.getPrototypeOf(base); },
    setPrototypeOf() { return false; },
    preventExtensions() { return false; },
  }) as Draftable;
  state.proxy = proxy;
  draftStates.set(proxy as object, state);
  return state;
}

function finishValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== "object") return value;
  const state = draftStates.get(value as object);
  if (state) {
    if (!state.copy) return state.base as T;
    const result = state.copy;
    if (seen.has(value as object)) return seen.get(value as object) as T;
    seen.set(value as object, result);
    for (const key of Reflect.ownKeys(result)) {
      const current = Reflect.get(result, key);
      const finished = finishValue(current, seen);
      if (finished !== current) Reflect.set(result, key, finished);
    }
    return result as T;
  }
  if (!isDraftable(value)) return value;
  let result: Draftable | undefined;
  for (const key of Reflect.ownKeys(value)) {
    const current = Reflect.get(value, key);
    const finished = finishValue(current, seen);
    if (finished !== current) {
      result ??= shallowCopy(value as Draftable);
      Reflect.set(result, key, finished);
    }
  }
  return (result ?? value) as T;
}

/** Start a lazy copy-on-write draft for JSON-shaped editor values. */
export function createCopyOnWrite<T extends object>(base: T): T {
  if (!isDraftable(base)) throw new TypeError("A plain object or array is required.");
  return createDraftState(base as Draftable).proxy as T;
}

/** Return the immutable result, reusing every untouched object and array. */
export function finishCopyOnWrite<T>(draft: T): T {
  return finishValue(draft);
}

/** Clone a value while safely unwrapping draft proxies nested inside it. */
export function cloneEditorValue<T>(value: T): T {
  return structuredClone(finishValue(value));
}
