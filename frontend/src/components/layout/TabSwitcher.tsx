import { ChevronDown } from "lucide-react";
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
 */
export function TabSwitcher({
  tabs,
  value,
  onValueChange,
  className,
}: TabSwitcherProps) {
  const active = tabs.find((t) => t.value === value) ?? tabs[0];
  const ActiveIcon = active.icon;

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
      <TabsList className="hidden sm:flex bg-slate-800 border border-slate-700">
        {tabs.map(({ value: v, label, icon: Icon }) => (
          <TabsTrigger
            key={v}
            value={v}
            className="data-[state=active]:bg-teal-600 data-[state=active]:text-white text-slate-400"
          >
            <Icon className="w-4 h-4 mr-2" /> {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </>
  );
}
