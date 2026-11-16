import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Tap-or-click help bubble. Popovers (not hover tooltips) so it works on touch screens like iPhone Safari. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-[18px]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" collisionPadding={12} className="w-[min(20rem,calc(100vw-1.5rem))] space-y-2 text-sm leading-6">
        {children}
      </PopoverContent>
    </Popover>
  );
}
