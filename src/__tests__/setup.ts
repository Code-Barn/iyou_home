/*
 * Copyright (C) 2026 David Byers dba Byers Brands
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import "@testing-library/jest-dom";

// vitest's jsdom environment does not surface window.localStorage; provide a
// spec-compliant in-memory Storage so components using it can be tested.
function installStorage() {
  if (typeof globalThis.localStorage !== "undefined") {
    return;
  }
  const createStore = () => {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear() {
        data.clear();
      },
      getItem(key: string) {
        return data.has(key) ? data.get(key)! : null;
      },
      key(index: number) {
        return Array.from(data.keys())[index] ?? null;
      },
      removeItem(key: string) {
        data.delete(key);
      },
      setItem(key: string, value: string) {
        data.set(key, String(value));
      },
    } as unknown as Storage;
  };
  const storage = createStore();
  for (const view of [globalThis, globalThis.window]) {
    (view as unknown as Record<string, unknown>).localStorage = storage;
  }
  const { document } = globalThis as { document?: Document };
  if (document?.defaultView) {
    (document.defaultView as unknown as Record<string, unknown>).localStorage = storage;
  }
}

installStorage();

// jsdom does not implement Element#scrollIntoView; the chat thread scrolls on
// message append, so stub it out for tests.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}
