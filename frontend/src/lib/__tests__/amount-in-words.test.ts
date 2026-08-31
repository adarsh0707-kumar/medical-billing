import { describe, it, expect } from "vitest";
import { amountInWords } from "../amount-in-words";

describe("amountInWords", () => {
  // The figure on the distributor invoice this format was modelled on.
  it("spells the sample invoice's total", () => {
    expect(amountInWords(1245)).toBe(
      "Rupees One Thousand Two Hundred and Forty Five Only",
    );
  });

  it.each([
    [0, "Rupees Zero Only"],
    [1, "Rupees One Only"],
    [15, "Rupees Fifteen Only"],
    [20, "Rupees Twenty Only"],
    [99, "Rupees Ninety Nine Only"],
    [100, "Rupees One Hundred Only"],
    [101, "Rupees One Hundred and One Only"],
    [1000, "Rupees One Thousand Only"],
  ])("spells %d", (value, expected) => {
    expect(amountInWords(value)).toBe(expected);
  });

  // Indian grouping, which is the whole reason this is not a two-line function:
  // 150000 is one lakh fifty thousand, never one hundred fifty thousand.
  it("groups in lakhs and crores, not thousands", () => {
    expect(amountInWords(150000)).toBe("Rupees One Lakh Fifty Thousand Only");
    expect(amountInWords(10000000)).toBe("Rupees One Crore Only");
    expect(amountInWords(12345678)).toBe(
      "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred and Seventy Eight Only",
    );
  });

  it("names the paise when there are any", () => {
    expect(amountInWords(1245.5)).toBe(
      "Rupees One Thousand Two Hundred and Forty Five and Fifty Paise Only",
    );
    expect(amountInWords(0.05)).toBe("Rupees Zero and Five Paise Only");
  });

  // Guard: rounding in rupees first drops a paisa on totals that are exact in
  // the database, and the words would then contradict the figure beside them.
  it("does not lose a paisa to float arithmetic", () => {
    expect(amountInWords(43.65)).toBe(
      "Rupees Forty Three and Sixty Five Paise Only",
    );
    expect(amountInWords(1243.71)).toBe(
      "Rupees One Thousand Two Hundred and Forty Three and Seventy One Paise Only",
    );
  });

  it("returns figures rather than wrong words above a crore-scale ceiling", () => {
    expect(amountInWords(99_99_99_99_999)).toContain("99999999999.00");
  });

  it("is empty for a value that is not a positive amount", () => {
    expect(amountInWords(-5)).toBe("");
    expect(amountInWords(Number.NaN)).toBe("");
  });
});
