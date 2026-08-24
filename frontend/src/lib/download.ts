import api from "@/lib/api";

/**
 * Downloads a CSV export (FR-RPT-09).
 *
 * Goes through the axios client rather than pointing an `<a href>` at the URL,
 * because these endpoints authenticate with a Bearer header a plain link cannot
 * set. Routing through `api` also means the export inherits the silent
 * token-refresh already built into the client — otherwise the first download
 * after a token expiry would fail with a raw 401 and no way to retry.
 */

/**
 * The server names the file — it knows the period, the threshold and the window
 * the report actually covered. Re-deriving the name here would be a second
 * source of truth that drifts the moment a query default changes.
 */
const filenameFrom = (disposition: unknown): string | null => {
  if (typeof disposition !== "string") return null;
  const match = /filename="([^"]+)"/.exec(disposition);
  return match ? match[1] : null;
};

export async function downloadCsv(url: string, fallbackName: string) {
  const res = await api.get(url, { responseType: "blob" });

  const href = URL.createObjectURL(res.data as Blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filenameFrom(res.headers["content-disposition"]) ?? fallbackName;
  // Firefox will not follow a click on a node outside the document.
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Released on the next tick: revoking synchronously can cancel the download
  // in WebKit before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
