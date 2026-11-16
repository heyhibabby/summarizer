import { useCallback, useEffect, useRef, useState } from "react";
import { PROVIDER_IDS, sanitizeKey, type ProviderId } from "./providers";
import { DEFAULT_RATIO } from "./summarizer";

export type EngineChoice = "offline" | ProviderId;
export type Prefs = {
  engine: EngineChoice;
  /** true → keys kept on this device (localStorage); false → this tab only (sessionStorage) */
  persist: boolean;
  models: Partial<Record<ProviderId, string>>;
  ratio: number;
};
export type Keys = Partial<Record<ProviderId, string>>;

const PREFS_KEY = "briefly-prefs-v2";
const KEYS_KEY = "briefly-keys-v2";
const OLD_KEYS = "briefly-provider-keys-v1";
const OLD_SETTINGS = "briefly-provider-settings-v1";

export const DEFAULT_PREFS: Prefs = { engine: "offline", persist: true, models: {}, ratio: DEFAULT_RATIO };

function read<T>(storage: Storage | undefined, key: string): T | null {
  try {
    const value = storage?.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function cleanKeys(raw: unknown): Keys {
  const out: Keys = {};
  if (raw && typeof raw === "object") {
    for (const id of PROVIDER_IDS) {
      const value = (raw as Record<string, unknown>)[id];
      if (typeof value === "string" && sanitizeKey(value)) out[id] = sanitizeKey(value);
    }
  }
  return out;
}

function loadAll(): { prefs: Prefs; keys: Keys } {
  const local = typeof localStorage === "undefined" ? undefined : localStorage;
  const session = typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  const stored = read<Partial<Prefs>>(local, PREFS_KEY);
  const prefs: Prefs = { ...DEFAULT_PREFS, ...(stored ?? {}), models: { ...(stored?.models ?? {}) } };
  let keys: Keys = { ...cleanKeys(read(local, KEYS_KEY)), ...cleanKeys(read(session, KEYS_KEY)) };
  if (!stored) {
    // One-time migration from the first version of the app.
    const oldKeys = cleanKeys(read(local, OLD_KEYS));
    if (Object.keys(oldKeys).length) {
      keys = { ...oldKeys, ...keys };
      const old = read<{ provider?: string; models?: Prefs["models"] }>(local, OLD_SETTINGS);
      prefs.models = { ...(old?.models ?? {}) };
      if (old?.provider && (PROVIDER_IDS as string[]).includes(old.provider)) prefs.engine = old.provider as ProviderId;
    }
  }
  if (prefs.engine !== "offline" && !(PROVIDER_IDS as string[]).includes(prefs.engine)) prefs.engine = "offline";
  if (!(prefs.ratio >= 0.01 && prefs.ratio <= 0.4)) prefs.ratio = DEFAULT_RATIO;
  return { prefs, keys };
}

export function useSettings() {
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [keys, setKeysState] = useState<Keys>({});
  const [hydrated, setHydrated] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const first = useRef(true);

  useEffect(() => {
    const loaded = loadAll();
    setPrefsState(loaded.prefs);
    setKeysState(loaded.keys);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (first.current) {
      first.current = false;
    }
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      const target = prefs.persist ? localStorage : sessionStorage;
      const other = prefs.persist ? sessionStorage : localStorage;
      target.setItem(KEYS_KEY, JSON.stringify(keys));
      other.removeItem(KEYS_KEY);
      if (prefs.persist || !Object.keys(keys).length) localStorage.removeItem(OLD_KEYS);
      setStorageOk(true);
    } catch {
      setStorageOk(false);
    }
  }, [prefs, keys, hydrated]);

  const setPrefs = useCallback((patch: Partial<Prefs>) => setPrefsState((current) => ({ ...current, ...patch })), []);
  const setKey = useCallback((provider: ProviderId, key: string | null) => {
    setKeysState((current) => {
      const next = { ...current };
      if (key) next[provider] = sanitizeKey(key);
      else delete next[provider];
      return next;
    });
  }, []);
  const setModel = useCallback((provider: ProviderId, model: string) => setPrefsState((current) => ({ ...current, models: { ...current.models, [provider]: model } })), []);
  const clearAllKeys = useCallback(() => {
    setKeysState({});
    setPrefsState((current) => ({ ...current, models: {}, engine: "offline" }));
    try {
      localStorage.removeItem(OLD_KEYS);
      localStorage.removeItem(OLD_SETTINGS);
    } catch {
      /* ignore */
    }
  }, []);

  return { prefs, keys, hydrated, storageOk, setPrefs, setKey, setModel, clearAllKeys };
}
