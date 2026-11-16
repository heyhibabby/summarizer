import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type PaletteId = "sage" | "ocean" | "sunset" | "rose" | "violet" | "graphite";

export const PALETTES: { id: PaletteId; label: string; swatch: string; pptx: { bg: string; ink: string; accent: string; soft: string } }[] = [
  { id: "sage", label: "Sage", swatch: "#2f5d52", pptx: { bg: "F6F5EF", ink: "183A36", accent: "D4684B", soft: "697570" } },
  { id: "ocean", label: "Ocean", swatch: "#2563a8", pptx: { bg: "F3F7FB", ink: "14385F", accent: "0E8FA3", soft: "5E7388" } },
  { id: "sunset", label: "Sunset", swatch: "#c2561c", pptx: { bg: "FBF6F0", ink: "5A2A10", accent: "D9482B", soft: "8A6F5E" } },
  { id: "rose", label: "Rose", swatch: "#b23a5b", pptx: { bg: "FBF4F6", ink: "5B1D33", accent: "C23A6E", soft: "86697A" } },
  { id: "violet", label: "Violet", swatch: "#6b4bb5", pptx: { bg: "F7F4FB", ink: "2F1F5C", accent: "A23FB0", soft: "70658A" } },
  { id: "graphite", label: "Graphite", swatch: "#2b2f36", pptx: { bg: "F5F6F7", ink: "1D2127", accent: "2F6FE0", soft: "68707A" } },
];

const STORAGE_KEY = "briefly-theme-v1";

/** Runs before first paint (inlined in <head>) so there is no flash of the wrong theme. */
export const themeInitScript = `(function(){try{var t=JSON.parse(localStorage.getItem("${STORAGE_KEY}")||"{}");var m=t.mode||"system";var d=m==="dark"||(m==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;if(d)r.classList.add("dark");r.dataset.palette=t.palette||"sage";}catch(e){}})();`;

type ThemeState = { mode: ThemeMode; palette: PaletteId };
const Ctx = createContext<{ mode: ThemeMode; palette: PaletteId; resolved: "light" | "dark"; setMode: (m: ThemeMode) => void; setPalette: (p: PaletteId) => void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThemeState>({ mode: "system", palette: "sage" });
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<ThemeState>;
      setState({ mode: stored.mode ?? "system", palette: PALETTES.some((p) => p.id === stored.palette) ? (stored.palette as PaletteId) : "sage" });
    } catch {
      /* defaults */
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(query.matches);
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  const resolved: "light" | "dark" = state.mode === "system" ? (systemDark ? "dark" : "light") : state.mode;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.dataset["palette"] = state.palette;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", getComputedStyle(document.body).backgroundColor || (resolved === "dark" ? "#1c1f1e" : "#faf9f4"));
  }, [resolved, state.palette]);

  const persist = (next: ThemeState) => {
    setState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const bump = () => {
    const root = document.documentElement;
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 350);
  };
  const setMode = useCallback((mode: ThemeMode) => { bump(); persist({ ...state, mode }); }, [state]);
  const setPalette = useCallback((palette: PaletteId) => { bump(); persist({ ...state, palette }); }, [state]);
  const value = useMemo(() => ({ ...state, resolved, setMode, setPalette }), [state, resolved, setMode, setPalette]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
