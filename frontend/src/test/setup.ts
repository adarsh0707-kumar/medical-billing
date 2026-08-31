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
