/**
 * HSN codes a pharmacy actually uses, with what each one covers.
 *
 * HSN is the national classification a GST invoice is filed against, so unlike
 * a category or a unit these are **not** the shop's to invent — the code either
 * is the government's code for what is being sold or it is wrong. What the shop
 * does have to do is pick the right one, and `30049099` against `30049011`
 * decided from memory at the counter is how a return comes back wrong.
 *
 * So the field offers the codes with their descriptions rather than an eight
 * digit box and a good memory.
 *
 * ─── Why the list is not the whole rule ──────────────────────────────────────
 *
 * These twelve cover a general pharmacy's stock and are nowhere near the whole
 * schedule. A shop that starts selling surgical instruments, a device, or a
 * food supplement outside `21069099` needs a code that is not here, and a
 * closed list would leave them filing under something they know is wrong —
 * which is exactly what the nine-value `unit` enum did until 2026-09-01, and
 * why it is gone. The field takes any code; the list is the shortcut.
 *
 * The rate hints in three of the descriptions are the government's, and they
 * are there because those three are the surprises: a medicated shampoo is not
 * taxed like a medicine. Nothing here *sets* the GST rate from the code —
 * `gstPercent` stays the operator's to choose, because a wrong rate applied
 * silently is a filing error nobody sees.
 */
export interface HsnEntry {
  code: string;
  description: string;
}

export const HSN_CODES: HsnEntry[] = [
  { code: "30041011", description: "Medicaments containing penicillins" },
  { code: "30042099", description: "Medicaments containing other antibiotics" },
  { code: "30043110", description: "Insulin" },
  { code: "30043900", description: "Medicaments containing hormones" },
  { code: "30045000", description: "Medicaments containing vitamins" },
  { code: "30049011", description: "Ayurvedic / Unani / Siddha medicaments" },
  { code: "30049099", description: "Other medicaments, retail packing" },
  { code: "30051090", description: "Adhesive dressings and bandages" },
  { code: "21069099", description: "Food preparations / sweeteners (18%)" },
  { code: "33049990", description: "Skin care preparations, baby oil (18%)" },
  { code: "33051090", description: "Medicated shampoo (18%)" },
  { code: "90183100", description: "Syringes, with or without needles" },
];

const BY_CODE = new Map(HSN_CODES.map((entry) => [entry.code, entry.description]));

/** What a code covers, or `undefined` for one that is not on the list. */
export const hsnDescription = (code?: string | null): string | undefined =>
  code ? BY_CODE.get(code) : undefined;

/**
 * The reference list, with `current` merged in when it is not already on it.
 *
 * Without this, opening a medicine saved under a code outside the twelve shows
 * an empty box, and saving the form again silently drops the code it was
 * filed under. The catalogue holds six-digit codes from before this list
 * existed, so that is the common case rather than the exotic one.
 */
export const hsnOptions = (current?: string | null): HsnEntry[] =>
  current && !BY_CODE.has(current)
    ? [...HSN_CODES, { code: current, description: "Already in use" }]
    : HSN_CODES;
