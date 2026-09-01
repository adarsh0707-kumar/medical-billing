import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export interface TabItem {
  value: string;
  label: string;
  icon: LucideIcon;
}

interface TabSwitcherProps {
  tabs: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

/**
 * The section switcher for Inventory, Reports and Settings — a tab strip on a
 * desktop, a dropdown on a phone.
 *
 * Four labelled tabs need roughly 520px. On a 360px screen the strip either
 * overflowed the viewport, taking the whole document sideways with it, or
 * clipped its last tab — "Suppliers" and "User Management" were unreachable,
 * with nothing on screen to suggest they existed. A dropdown costs one tap and
 * always shows the full set.
 *
 * A native `<select>` rather than a styled listbox, deliberately: it opens the
 * platform's own picker — the wheel on iOS, the sheet on Android — which is
 * both the interaction people already know and the one that stays usable with
 * a screen reader or a keyboard, for none of the code a custom menu costs.
 * The chevron and the active tab's icon are drawn behind it; the select itself
 * is transparent and sits on top, so the whole control is the hit target.
 *
 * Both forms render, one hidden per breakpoint, so `TabsTrigger` stays inside
 * `TabsList` where Radix requires it. The pages hold the value, which is why
 * they moved from `defaultValue` to `value` + `onValueChange`.
 *
 * **The desktop strip scrolls, with arrows.** Reports reached ten tabs and the
 * last of them — Sales Trend and Stock Alerts — ran off the right of a laptop
 * screen with nothing to say they were there: the same defect the phone
 * dropdown was built to fix, returning at a wider breakpoint as the strip grew.
 * The arrows appear only on the side there is something to scroll to, so a
 * strip that fits still looks exactly as it did.
 */
export function TabSwitcher({
  tabs,
  value,
  onValueChange,
  className,
}: TabSwitcherProps) {
  const active = tabs.find((t) => t.value === value) ?? tabs[0];
  const ActiveIcon = active.icon;

  const stripRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  /** Which arrows to draw: is there anything off either edge right now? */
  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    // A pixel of slack. Sub-pixel layout leaves scrollWidth a hair above
    // clientWidth on strips that visibly fit, and an arrow that scrolls
    // nothing is worse than no arrow.
    const slack = 1;
    setOverflow({
      left: el.scrollLeft > slack,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - slack,
    });
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    measure();
    // Re-measured on resize *and* on tab-set changes — Reports adds or removes
    // tabs with the viewer's role, so the strip can start fitting and stop.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, tabs.length]);

  /**
   * Keep the selected tab in view when it is chosen from somewhere other than
   * a click on itself — the phone dropdown, or a page setting the tab.
   */
  useEffect(() => {
    const el = stripRef.current;
    const selected = el?.querySelector<HTMLElement>('[data-state="active"]');
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);

  const scrollBy = (direction: 1 | -1) => {
    const el = stripRef.current;
    if (!el) return;
    // Most of a screenful, not all of it: a tab or two stays visible across
    // the jump so the reader keeps their place.
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  };

  const arrowCls =
    "absolute top-1/2 -translate-y-1/2 z-10 h-8 w-8 grid place-items-center " +
    "rounded-full bg-slate-800 border border-slate-600 text-slate-300 " +
    "hover:bg-slate-700 hover:text-white shadow-lg shadow-black/60";

  return (
    <>
      {/* Phone */}
      <div className={cn("relative sm:hidden", className)}>
        <ActiveIcon className="w-4 h-4 text-teal-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <select
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          aria-label="Section"
          className="w-full appearance-none bg-slate-800 border border-slate-700 text-white text-sm font-medium rounded-lg pl-9 pr-9 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          {tabs.map(({ value: v, label }) => (
            <option key={v} value={v} className="bg-slate-800 text-white">
              {label}
            </option>
          ))}
        </select>
        <ChevronDown className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>

      {/* Desktop */}
      <div className="hidden sm:block relative">
        {overflow.left && (
          <button
            type="button"
            onClick={() => scrollBy(-1)}
            aria-label="Scroll tabs left"
            className={cn(arrowCls, "left-0")}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}

        <div
          ref={stripRef}
          onScroll={measure}
          // `scrollbar-none` rather than a visible bar: the arrows say what
          // can be scrolled, and a scrollbar under a tab strip reads as part
          // of the page rather than as part of the control.
          className="overflow-x-auto scrollbar-none"
        >
          <TabsList className="flex w-max bg-slate-800 border border-slate-700">
            {tabs.map(({ value: v, label, icon: Icon }) => (
              <TabsTrigger
                key={v}
                value={v}
                className="shrink-0 data-[state=active]:bg-teal-600 data-[state=active]:text-black text-slate-400"
              >
                <Icon className="w-4 h-4 mr-2" /> {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {overflow.right && (
          <button
            type="button"
            onClick={() => scrollBy(1)}
            aria-label="Scroll tabs right"
            className={cn(arrowCls, "right-0")}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </>
  );
}
