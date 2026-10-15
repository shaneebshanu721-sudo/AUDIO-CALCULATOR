// storage.js — local persistence in this browser only (localStorage).
// Financial entries never leave the device unless the user exports them.

import { validateState } from './exporter.js';
import { createInitialState } from './ledger.js';

export const STORAGE_KEY = 'voice-audit-calculator.v1';

/**
 * Load state. Returns { state, warning }. A corrupted save is preserved under a
 * separate key (never silently thrown away) and a fresh state is started.
 */
export function loadState(storage = globalThis.localStorage) {
  let raw = null;
  try { raw = storage.getItem(STORAGE_KEY); } catch {
    return { state: createInitialState(), warning: 'Browser storage is blocked (private mode?). Entries will not be saved — export often.' };
  }
  if (!raw) return { state: createInitialState(), warning: null };
  try {
    return { state: validateState(JSON.parse(raw)), warning: null };
  } catch (err) {
    const rescueKey = `${STORAGE_KEY}.corrupt-${Date.now()}`;
    try { storage.setItem(rescueKey, raw); } catch { /* ignore */ }
    return { state: createInitialState(), warning: `Saved data could not be read (${err.message}). A raw copy was kept under "${rescueKey}". Restore from your latest JSON backup.` };
  }
}

/** Save state. Returns null on success or an error message. */
export function saveState(state, storage = globalThis.localStorage) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return null;
  } catch (err) {
    return err && err.name === 'QuotaExceededError'
      ? 'Device storage is full — entries are NOT being saved. Export a CSV/backup now.'
      : 'Could not save to browser storage — export a CSV/backup now.';
  }
}

/** Remove every key this app wrote. */
export function wipeAll(storage = globalThis.localStorage) {
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(STORAGE_KEY)) keys.push(k);
    }
    keys.forEach((k) => storage.removeItem(k));
  } catch { /* ignore */ }
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}
