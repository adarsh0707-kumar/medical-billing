import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import {
  buildApp,
  signIn,
  makeSellable,
  makeShop,
  line,
} from "../helpers/factory.js";

/**
 * The Schedule H register — FR-MED-12, Rule 65(11).
 *
 * The particulars were being recorded from 2026-08-24 and could not be
 * produced: `Prescription` carried indexes on `prescriberRegNo` and
 * `prescribedOn`, its own schema comment named the query an inspection asks,
 * and no endpoint asked it. Producing the register meant a psql prompt.
 *
 * The properties worth the most here are the two that separate this from a
 * generic list: it filters on `prescribedOn` rather than the date of supply,
 * and it is scoped through the invoice, because the row itself has no shopId.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

const get = (token, path) => as(token, "get", path);

const REGISTER = "/api/reports/prescriptions";

const rx = (over = {}) => ({
  prescriberName: "Dr A. Mehta",
  prescriberRegNo: "MMC/12345",
  prescribedOn: "2026-03-10",
  patientName: "Sunita Rao",
  ...over,
});

/** A medicine that cannot be sold without a prescription. */
const scheduledH = async (opts = {}) => {
  const { medicine, batch } = await makeSellable({ quantity: 50, ...opts });
  await prisma.medicine.update({
    where: { id: medicine.id },
    data: { isScheduledH: true },
  });
  return { medicine, batch };
};

/**
 * A real Schedule H sale, through the billing endpoint rather than by inserting
 * a Prescription row. The register has to survive the join it actually reads.
 */
const dispense = async (
  token,
  { prescription, quantity = 2, when, shopId } = {},
) => {
  const { medicine, batch } = await scheduledH({ shopId });
  const res = await as(token, "post", "/api/billing/invoices", {
    items: [line(medicine, batch, { quantity })],
    paymentMode: "CASH",
    paymentStatus: "PAID",
    prescription: prescription ?? rx(),
  });
  expect(res.status).toBe(201);

  if (when) {
    await prisma.invoice.update({
      where: { id: res.body.data.id },
      data: { date: when },
    });
  }
  return { invoice: res.body.data, medicine, batch };
};

const names = (body) => body.data.map((r) => r.prescriberName);

describe("GET /api/reports/prescriptions", () => {
  it("produces the particulars of every Schedule H supply", async () => {
    const { token } = await signIn(app);
    const { medicine } = await dispense(token, { quantity: 3 });

    const res = await get(token, REGISTER);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const [entry] = res.body.data;
    expect(entry).toMatchObject({
      prescriberName: "Dr A. Mehta",
      prescriberRegNo: "MMC/12345",
      patientName: "Sunita Rao",
    });
    // What was handed over against it — the half that makes the row an answer
    // rather than a reference to look up somewhere else.
    expect(entry.invoice.invoiceNumber).toBeTruthy();
    expect(entry.invoice.items).toEqual([
      { medicineName: medicine.name, quantity: 3 },
    ]);
  });

  it("lists the most recently prescribed first", async () => {
    const { token } = await signIn(app);
    await dispense(token, {
      prescription: rx({ prescriberName: "Dr Older", prescribedOn: "2026-01-04" }),
    });
    await dispense(token, {
      prescription: rx({ prescriberName: "Dr Newer", prescribedOn: "2026-05-19" }),
    });

    expect(names((await get(token, REGISTER)).body)).toEqual([
      "Dr Newer",
      "Dr Older",
    ]);
  });

  it("returns an empty register rather than an error when nothing is dispensed", async () => {
    const { token } = await signIn(app);

    const res = await get(token, REGISTER);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toMatchObject({ total: 0, pages: 0 });
  });

  it("counts and paginates", async () => {
    const { token } = await signIn(app);
    for (const n of [1, 2, 3]) {
      await dispense(token, {
        prescription: rx({ prescriberName: `Dr ${n}` }),
      });
    }

    const res = await get(token, `${REGISTER}?page=2&limit=2`);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({
      total: 3,
      page: 2,
      limit: 2,
      pages: 2,
    });
  });

  // ─── The search box ────────────────────────────────────────────────────────
  //
  // An inspector arrives holding one of three things — a doctor's name, a
  // registration number, or a patient — and should not have to know which field
  // the system filed it under.
  describe("search", () => {
    const seed = async (token) => {
      await dispense(token, {
        prescription: rx({
          prescriberName: "Dr Priya Nair",
          prescriberRegNo: "KMC/99887",
          patientName: "Ravi Kumar",
        }),
      });
      await dispense(token, {
        prescription: rx({
          prescriberName: "Dr Sameer Joshi",
          prescriberRegNo: "MMC/11223",
          patientName: "Anita Desai",
        }),
      });
    };

    it("matches the prescriber's name", async () => {
      const { token } = await signIn(app);
      await seed(token);
      expect(names((await get(token, `${REGISTER}?search=Nair`)).body)).toEqual([
        "Dr Priya Nair",
      ]);
    });

    it("matches the registration number", async () => {
      const { token } = await signIn(app);
      await seed(token);
      const res = await get(token, `${REGISTER}?search=KMC/99887`);
      expect(names(res.body)).toEqual(["Dr Priya Nair"]);
    });

    it("matches the patient", async () => {
      const { token } = await signIn(app);
      await seed(token);
      const res = await get(token, `${REGISTER}?search=Anita`);
      expect(names(res.body)).toEqual(["Dr Sameer Joshi"]);
    });

    it("ignores case", async () => {
      const { token } = await signIn(app);
      await seed(token);
      expect(
        names((await get(token, `${REGISTER}?search=priya`)).body),
      ).toEqual(["Dr Priya Nair"]);
    });

    it("treats a cleared box as no filter", async () => {
      const { token } = await signIn(app);
      await seed(token);
      expect((await get(token, `${REGISTER}?search=`)).body.data).toHaveLength(
        2,
      );
    });
  });

  // ─── prescribedOn, not the date of supply ─────────────────────────────────
  //
  // The two dates differ whenever a customer fills a prescription later than it
  // was written, which is most of them. An inspection asks when the
  // practitioner wrote it; filtering on the invoice date would silently answer
  // a different question.
  describe("the date filter", () => {
    it("filters on when the prescription was written", async () => {
      const { token } = await signIn(app);
      await dispense(token, {
        prescription: rx({
          prescriberName: "Dr Written In March",
          prescribedOn: "2026-03-15",
        }),
      });
      await dispense(token, {
        prescription: rx({
          prescriberName: "Dr Written In May",
          prescribedOn: "2026-05-15",
        }),
      });

      const res = await get(
        token,
        `${REGISTER}?startDate=2026-03-01&endDate=2026-03-31`,
      );
      expect(names(res.body)).toEqual(["Dr Written In March"]);
    });

    it("does not filter on the date of supply", async () => {
      const { token } = await signIn(app);
      // Written in March, dispensed in June — the customer took their time.
      await dispense(token, {
        prescription: rx({
          prescriberName: "Dr March",
          prescribedOn: "2026-03-15",
        }),
        when: new Date(2026, 5, 20, 10, 0),
      });

      const inMarch = await get(
        token,
        `${REGISTER}?startDate=2026-03-01&endDate=2026-03-31`,
      );
      expect(names(inMarch.body)).toEqual(["Dr March"]);

      const inJune = await get(
        token,
        `${REGISTER}?startDate=2026-06-01&endDate=2026-06-30`,
      );
      expect(inJune.body.data).toEqual([]);
    });

    it("rejects an unparseable date rather than returning an unfiltered register", async () => {
      const { token } = await signIn(app);
      await dispense(token);

      const res = await get(
        token,
        `${REGISTER}?startDate=not-a-date&endDate=2026-03-31`,
      );
      expect(res.status).toBe(400);
    });

    it("caps limit rather than honouring an unbounded one (T-10)", async () => {
      const { token } = await signIn(app);
      expect((await get(token, `${REGISTER}?limit=999999`)).status).toBe(400);
    });
  });

  // ─── Tenancy ──────────────────────────────────────────────────────────────
  //
  // `Prescription` has no shopId of its own; it is scoped through the invoice
  // it hangs off. That is the sort of indirection a leak hides in, so it is
  // tested against a real second shop rather than asserted in a comment.
  describe("tenancy", () => {
    it("shows only this shop's register", async () => {
      const { token: mine } = await signIn(app);
      await dispense(mine, {
        prescription: rx({ prescriberName: "Dr Mine" }),
      });

      const other = await makeShop();
      const { token: theirs } = await signIn(app, "ADMIN", {
        shopId: other.id,
        email: "prescription-other-shop@test.local",
      });
      await dispense(theirs, {
        shopId: other.id,
        prescription: rx({ prescriberName: "Dr Theirs" }),
      });

      expect(names((await get(mine, REGISTER)).body)).toEqual(["Dr Mine"]);
      expect(names((await get(theirs, REGISTER)).body)).toEqual(["Dr Theirs"]);
    });
  });

  // ─── Who may read it ──────────────────────────────────────────────────────
  //
  // Every row names a patient and what they were dispensed, which is the most
  // sensitive join in this database (threat T-9). A pharmacist needs it —
  // dispensing Schedule H is their job — and a cashier does not.
  describe("authorisation", () => {
    it("lets a pharmacist read it", async () => {
      const { token } = await signIn(app, "PHARMACIST");
      expect((await get(token, REGISTER)).status).toBe(200);
    });

    it("refuses a cashier", async () => {
      const { token } = await signIn(app, "CASHIER");
      expect((await get(token, REGISTER)).status).toBe(403);
    });

    it("refuses an unauthenticated caller", async () => {
      expect((await request(app).get(REGISTER)).status).toBe(401);
    });
  });
});

describe("GET /api/reports/prescriptions/export", () => {
  const csv = (token, qs = "") => get(token, `${REGISTER}/export${qs}`);

  it("returns the register as a CSV attachment", async () => {
    const { token } = await signIn(app);
    const { medicine } = await dispense(token, { quantity: 4 });

    const res = await csv(token);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toContain(
      "prescription-register.csv",
    );

    const [header, row] = res.text.trim().split("\n");
    expect(header).toContain("Prescriber");
    expect(header).toContain("Reg. No");
    expect(header).toContain("Patient");
    expect(row).toContain("Dr A. Mehta");
    expect(row).toContain("MMC/12345");
    expect(row).toContain(`${medicine.name} x4`);
  });

  it("applies the same filters the screen shows", async () => {
    const { token } = await signIn(app);
    await dispense(token, {
      prescription: rx({ prescriberName: "Dr Keep" }),
    });
    await dispense(token, {
      prescription: rx({ prescriberName: "Dr Omit" }),
    });

    const res = await csv(token, "?search=Keep");

    expect(res.text).toContain("Dr Keep");
    expect(res.text).not.toContain("Dr Omit");
  });

  it("starts from the first row whatever page the screen is on", async () => {
    const { token } = await signIn(app);
    await dispense(token, {
      prescription: rx({ prescriberName: "Dr First", prescribedOn: "2026-05-01" }),
    });
    await dispense(token, {
      prescription: rx({ prescriberName: "Dr Second", prescribedOn: "2026-04-01" }),
    });

    // A compliance document is not a page of a table.
    const res = await csv(token, "?page=2&limit=1");

    expect(res.text).toContain("Dr First");
    expect(res.text).toContain("Dr Second");
  });

  it("refuses a cashier, like the screen it exports", async () => {
    const { token } = await signIn(app, "CASHIER");
    expect((await get(token, `${REGISTER}/export`)).status).toBe(403);
  });
});
