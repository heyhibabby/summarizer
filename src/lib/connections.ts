import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, detectProvider, listModels, pickDefaultModel, ProviderError, sanitizeKey, type ModelInfo, type ProviderId } from "./providers";
import type { Keys, Prefs } from "./settings";

export type Connection = {
  state: "checking" | "ok" | "unverified" | "error";
  models: ModelInfo[];
  message: string;
};
export type ConnectResult = { ok: boolean; message: string };

type Args = {
  hydrated: boolean;
  keys: Keys;
  prefs: Prefs;
  setKey: (provider: ProviderId, key: string | null) => void;
  setModel: (provider: ProviderId, model: string) => void;
};

/**
 * Tracks, per provider, whether its key works and which models it exposes.
 * Models are listed ONLY for providers that have a key, and only for that provider.
 */
export function useConnections({ hydrated, keys, prefs, setKey, setModel }: Args) {
  const [connections, setConnections] = useState<Partial<Record<ProviderId, Connection>>>({});
  const inflight = useRef(new Set<ProviderId>());
  const latest = useRef({ prefs, setKey, setModel });
  latest.current = { prefs, setKey, setModel };

  const connect = useCallback(async (provider: ProviderId, rawKey: string, options: { save: boolean }): Promise<ConnectResult> => {
    const key = sanitizeKey(rawKey);
    if (!key) return { ok: false, message: "Paste an API key first." };
    const detected = detectProvider(key);
    if (detected && detected !== provider && options.save) {
      const message = describeError(new ProviderError("auth", "mismatch"), provider, key);
      setConnections((c) => ({ ...c, [provider]: { state: "error", models: [], message } }));
      return { ok: false, message };
    }
    inflight.current.add(provider);
    setConnections((c) => ({ ...c, [provider]: { state: "checking", models: c[provider]?.models ?? [], message: "Checking key…" } }));
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const models = await listModels(provider, key, controller.signal);
      if (!models.length) throw new ProviderError("notfound", "The key works, but no text models are available to it. Check the provider’s account and billing.");
      if (options.save) latest.current.setKey(provider, key);
      const current = latest.current.prefs.models[provider];
      if (!current || !models.some((m) => m.id === current)) latest.current.setModel(provider, pickDefaultModel(provider, models));
      setConnections((c) => ({ ...c, [provider]: { state: "ok", models, message: `Connected · ${models.length} model${models.length === 1 ? "" : "s"} available` } }));
      return { ok: true, message: "Connected" };
    } catch (error) {
      const timedOut = controller.signal.aborted && !(error instanceof ProviderError && error.kind !== "aborted");
      const message = timedOut ? "The provider did not answer within 20 seconds. Check your connection and try again." : describeError(error, provider, key);
      const keyIsBad = error instanceof ProviderError && (error.kind === "auth" || error.kind === "permission");
      // A rejected key is never saved; a network problem keeps the key so the user does not have to retype it.
      if (options.save && !keyIsBad) latest.current.setKey(provider, key);
      setConnections((c) => ({ ...c, [provider]: { state: keyIsBad ? "error" : "unverified", models: [], message } }));
      return { ok: false, message };
    } finally {
      window.clearTimeout(timer);
      inflight.current.delete(provider);
    }
  }, []);

  const forget = useCallback((provider: ProviderId) => {
    setConnections((c) => {
      const next = { ...c };
      delete next[provider];
      return next;
    });
  }, []);

  const forgetAll = useCallback(() => setConnections({}), []);

  // Validate the saved key of the ACTIVE provider once after load (not on every keystroke).
  const active = prefs.engine;
  const activeKey = active === "offline" ? "" : (keys[active] ?? "");
  useEffect(() => {
    if (!hydrated || active === "offline" || !activeKey) return;
    if (connections[active] || inflight.current.has(active)) return;
    void connect(active, activeKey, { save: false });
  }, [hydrated, active, activeKey, connections, connect]);

  return { connections, connect, forget, forgetAll };
}
