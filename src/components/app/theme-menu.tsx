import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PALETTES, useTheme, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

const MODES: { id: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
  { id: "system", label: "Auto", Icon: Monitor },
];

export function ThemeMenu() {
  const { mode, palette, setMode, setPalette, resolved } = useTheme();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-10" aria-label="Change theme">
          {resolved === "dark" ? <Moon /> : <Palette />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={12} className="w-[min(18rem,calc(100vw-1.5rem))] space-y-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Appearance</p>
          <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-secondary p-1" role="radiogroup" aria-label="Appearance">
            {MODES.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={mode === id}
                onClick={() => setMode(id)}
                className={cn("flex h-10 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors", mode === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Colour</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Colour theme">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={palette === p.id}
                onClick={() => setPalette(p.id)}
                className={cn("flex h-14 flex-col items-center justify-center gap-1 rounded-lg border text-xs transition-colors", palette === p.id ? "border-primary bg-secondary font-semibold" : "border-border hover:bg-secondary/60")}
              >
                <span className="grid size-5 place-items-center rounded-full" style={{ background: p.swatch }}>
                  {palette === p.id && <Check className="size-3 text-white" />}
                </span>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
