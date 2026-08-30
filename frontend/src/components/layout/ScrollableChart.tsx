import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ScrollableChartProps {
  children: ReactNode;
  /** Override the floor when a chart carries more than about a week of points. */
  className?: string;
}

/**
 * Gives a time-series chart a minimum width and lets it scroll sideways inside
 * its card.
 *
 * Recharts' `ResponsiveContainer` fits the chart to whatever space it is given,
 * which on a phone meant squeezing seven daily labels into roughly 300px: the
 * dates collided into a grey smear and the bars were thinner than the gaps
 * between them. Compressing a chart until it is unreadable is not responsive,
 * it is just small.
 *
 * So the plot keeps a readable density and the card scrolls to it. The scroll
 * lives here rather than on the page — that rule is why the layout no longer
 * drags the whole document sideways — and the fade on the right edge is there
 * because a scroll container with no visible overflow looks like a chart that
 * has simply been cut off. It is hidden from `sm` up, where the full width fits
 * and nothing scrolls.
 */
export function ScrollableChart({ children, className }: ScrollableChartProps) {
  return (
    <div className="relative">
      <div className="overflow-x-auto [scrollbar-width:thin]">
        <div className={cn("min-w-[34rem]", className)}>{children}</div>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-slate-900 to-transparent sm:hidden"
      />
    </div>
  );
}
