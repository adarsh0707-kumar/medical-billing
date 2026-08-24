import { useEffect, useState } from "react";

/**
 * Delays a value until it has stopped changing for `delay` ms.
 *
 * This is the one effect-plus-setState pair the query migration deliberately
 * keeps (G-16). The rule it would otherwise trip exists to stop *data fetching*
 * happening in an effect body; debouncing an input is not a fetch, it is the
 * input settling. The setState here runs on a timer, never synchronously during
 * the effect, which is exactly the shape the rule permits.
 *
 * Pairing it with a query keyed on the debounced value is what removes the race:
 * the keystroke the user abandoned has its request cancelled instead of landing
 * on top of the current one.
 */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
