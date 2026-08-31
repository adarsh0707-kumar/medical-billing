/**
 * The rupee amount spelled out, for the invoice footer.
 *
 * A tax invoice carries the total in words as well as figures — it is the line
 * that makes a tampered figure obvious, which is why every printed bill has one.
 *
 * Indian grouping, not international: 1,50,000 is "One Lakh Fifty Thousand",
 * never "One Hundred Fifty Thousand". Crore is the largest group handled; above
 * 99,99,99,999 the number is returned in figures rather than mis-spelled, since
 * a pharmacy invoice will never reach it and a wrong word is worse than none.
 */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

/** 0–99. */
const underHundred = (n: number): string =>
  n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");

/** 0–999, with the "and" a spoken amount uses: "Two Hundred and Forty Five". */
const underThousand = (n: number): string => {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return underHundred(rest);
  return `${ONES[hundreds]} Hundred${rest ? ` and ${underHundred(rest)}` : ""}`;
};

const MAX = 9_99_99_99_999;

export function amountInWords(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";

  // Work in paise from the start. `Math.floor(value)` on a float total loses a
  // paisa often enough to matter on a document whose whole job is to agree with
  // the figure printed beside it.
  const totalPaise = Math.round(value * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;

  if (rupees > MAX) return `Rupees ${value.toFixed(2)} Only`;

  const groups: string[] = [];
  let rest = rupees;

  const crore = Math.floor(rest / 1_00_00_000);
  rest %= 1_00_00_000;
  const lakh = Math.floor(rest / 1_00_000);
  rest %= 1_00_000;
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;

  if (crore) groups.push(`${underThousand(crore)} Crore`);
  if (lakh) groups.push(`${underThousand(lakh)} Lakh`);
  if (thousand) groups.push(`${underThousand(thousand)} Thousand`);
  if (rest) groups.push(underThousand(rest));

  const rupeeWords = groups.length ? groups.join(" ") : "Zero";
  const paiseWords = paise ? ` and ${underHundred(paise)} Paise` : "";

  return `Rupees ${rupeeWords}${paiseWords} Only`;
}
