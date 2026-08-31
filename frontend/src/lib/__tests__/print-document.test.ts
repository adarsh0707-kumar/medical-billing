import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printAs } from "../print-document";

describe("printAs", () => {
  let printed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.title = "frontend";
    printed = vi.fn();
    vi.stubGlobal("print", printed);
    window.print = printed as unknown as typeof window.print;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.title = "";
  });

  it("names the document while the print dialog is open", () => {
    printAs("INV260831-0005");

    expect(printed).toHaveBeenCalledOnce();
    // Read at the moment print() is called, which is when the browser builds
    // the preview and decides the save-as filename.
    expect(document.title).toBe("INV260831-0005");
  });

  it("puts the original title back once printing ends", () => {
    printAs("INV260831-0005");
    window.dispatchEvent(new Event("afterprint"));

    expect(document.title).toBe("frontend");
  });

  // Restoring on the second print must not be poisoned by the first listener,
  // which is why the handler is registered `once`.
  it("survives repeated prints", () => {
    printAs("INV-A");
    window.dispatchEvent(new Event("afterprint"));
    printAs("INV-B");
    expect(document.title).toBe("INV-B");
    window.dispatchEvent(new Event("afterprint"));
    expect(document.title).toBe("frontend");
  });

  it("strips characters a filesystem would reject", () => {
    printAs('INV/2026:08*31?"<>|');
    expect(document.title).not.toMatch(/[\\/:*?"<>|]/);
    expect(document.title).toContain("INV");
  });

  it("still prints when given nothing usable as a name", () => {
    printAs("   ");
    expect(printed).toHaveBeenCalledOnce();
    expect(document.title).toBe("frontend");
  });
});
