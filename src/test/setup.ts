import '@testing-library/jest-dom/vitest';

// Node 22+ ships its own global `localStorage`, which shadows the real one
// vitest's jsdom environment tries to install — its key-allowlist predates
// that Node global, so jsdom's Storage instance never gets copied over and
// `globalThis.localStorage` resolves to Node's (permanently undefined
// without --localstorage-file). Reach into the jsdom instance vitest exposes
// as `globalThis.jsdom` and use its real Storage, so `Storage.prototype`
// spies in tests actually intercept the calls this app makes.
const jsdomLocalStorage = (globalThis as { jsdom?: { window?: { localStorage?: Storage } } }).jsdom
  ?.window?.localStorage;
if (jsdomLocalStorage) {
  globalThis.localStorage = jsdomLocalStorage;
} else if (typeof globalThis.localStorage === 'undefined') {
  const store: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach(key => delete store[key]);
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    length: Object.keys(store).length,
  } as any;
}
