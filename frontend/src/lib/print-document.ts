/**
 * Prints the page under a chosen document name.
 *
 * Browsers take the default filename for "Save as PDF" from `document.title`,
 * and print it in the page header too. This app's title is the Vite app name,
 * so a saved invoice landed on disk as `frontend.pdf` — every invoice
 * overwriting the last one in the Downloads folder, with nothing in the name to
 * say which sale it was.
 *
 * Setting the title for the duration of the print gives `INV260831-0005.pdf`
 * instead, which is also the number printed on the document itself.
 *
 * The title is restored on `afterprint`, which fires whether the dialog was
 * confirmed or cancelled. There is deliberately no timer fallback: restoring on
 * a guess races the browser, which reads the title when it builds the preview,
 * and a too-early restore would put `frontend.pdf` back in the save box. On a
 * browser that never fires `afterprint` the tab keeps the invoice number until
 * the next navigation, which is cosmetic.
 */

/** Filesystem-safe, and short enough to stay readable in a download list. */
const safeName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

export function printAs(documentName: string): void {
  const name = safeName(documentName);
  if (!name) {
    window.print();
    return;
  }

  const original = document.title;
  document.title = name;

  window.addEventListener(
    "afterprint",
    () => {
      document.title = original;
    },
    { once: true },
  );

  window.print();
}
