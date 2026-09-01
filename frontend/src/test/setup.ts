import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

/**
 * How long `findBy*` and `waitFor` keep retrying before giving up.
 *
 * Testing Library defaults to 1000ms, which is not enough for the screens that
 * search. The POS and batch-form medicine lookups are debounced by 300ms
 * (`useDebounced`), and only then does the query run and the result render — so
 * a `findByRole` for a search result has to cover a debounce, a request and a
 * paint inside one second. That fits comfortably on an idle machine and does
 * not on a busy one.
 *
 * The failure it produced was not a slow test but a wrong-looking one:
 * `Unable to find role="button" and name "Amoxicillin 500mg"`, which reads as a
 * missing element rather than one that had not arrived yet — so it invites
 * someone to go looking at the component. Measured 2026-08-31 with the machine
 * loaded: `Inventory.batches` failed that way while passing 6/6 when run on its
 * own.
 *
 * This weakens no assertion. `findBy*` still fails when the element genuinely
 * never appears; it just waits long enough first that a loaded CI runner is not
 * what decided the outcome. The companion setting is `testTimeout` in
 * `vitest.config.ts`, raised for the same reason and documented there.
 */
configure({ asyncUtilTimeout: 5000 });

/**
 * jsdom implements no `ResizeObserver`, and every browser does.
 *
 * `TabSwitcher` observes its own strip to decide whether to draw the scroll
 * arrows. Without a stub that constructor throws inside an effect, which React
 * reports as a render failure in every test that mounts a page with tabs —
 * 50 of them, none of which were about tabs.
 *
 * A stub that never fires is the honest shape here: jsdom does no layout, so
 * every element measures zero and a real implementation would have nothing
 * truthful to report anyway. Whether the arrows appear at the right moment is
 * a question about layout, which belongs to the Playwright flows.
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

/**
 * jsdom implements no scrolling either — `Element.prototype.scrollIntoView` is
 * simply absent, so calling it is a TypeError rather than a no-op.
 *
 * `TabSwitcher` scrolls the selected tab into view when the value changes from
 * outside the strip. Same reasoning as the observer above: there is no layout
 * here to scroll, and where the strip ends up is a browser question.
 */
Element.prototype.scrollIntoView ??= function scrollIntoViewStub() {};
