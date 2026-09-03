import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import {
  buildApp,
  signIn,
  makeMasters,
  makeSellable,
  makeShop,
} from "../helpers/factory.js";

/**
 * The distributor master, and the reorder preference that goes with it.
 *
 * `Supplier` held a name, a contact, a phone, an email, a GSTIN and one line of
 * address. A real supplier card carries the shop's own code for the
 * distributor, a structured address, their drug licence, the commercial terms
 * and a credit limit — and the master says which distributor each medicine is
 * *usually* bought from, which had nowhere to live at all: supplier existed
 * only on a batch, which records where one consignment came from.
 *
 * The two facts are kept apart on purpose. A batch's supplier is history and a
 * recall follows it; `Medicine.defaultSupplierId` is a preference and can be
 * wrong without making any past purchase wrong.
 */

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

const SUPPLIERS = "/api/suppliers";

/** One row of the sample distributor master, in full. */
const FULL_CARD = {
  code: "SUP-001",
  name: "Sharma Medical Agencies",
  contactName: "Rakesh Sharma",
  phone: "+91 94310 22781",
  email: "orders@sharmamedical.in",
  address: "Shop 14, Govind Mitra Road, Patna Market",
  city: "Patna",
  state: "Bihar",
  pincode: "800004",
  gstNumber: "10AAGCS4821K1ZP",
  drugLicenceNo: "BR/PAT/20B-2214, 21B-2215",
  paymentTerms: "30 days credit",
  deliveryDays: "Mon, Wed, Fri",
  creditLimit: 250000,
  notes: "General multi-company stockist — analgesics, antacids and fast-moving OTC",
};

describe("the supplier master", () => {
  it("stores every field a distributor card carries", async () => {
    const { token } = await signIn(app);

    const res = await as(token, "post", SUPPLIERS, FULL_CARD);

    expect(res.status).toBe(201);
    // Everything but the money, which comes back as a number through the API's
    // Decimal replacer and is asserted separately below.
    const { creditLimit, ...text } = FULL_CARD;
    expect(res.body.data).toMatchObject(text);
    expect(res.body.data.creditLimit).toBe(creditLimit);
  });

  it("reads the whole card back on the list and the detail", async () => {
    const { token } = await signIn(app);
    const created = await as(token, "post", SUPPLIERS, FULL_CARD);

    const one = await as(token, "get", `${SUPPLIERS}/${created.body.data.id}`);
    const list = await as(token, "get", SUPPLIERS);

    expect(one.body.data).toMatchObject({
      code: "SUP-001",
      drugLicenceNo: "BR/PAT/20B-2214, 21B-2215",
      pincode: "800004",
    });
    expect(list.body.data[0].paymentTerms).toBe("30 days credit");
  });

  it("keeps the credit limit exact rather than as a float", async () => {
    const { token } = await signIn(app);

    const res = await as(token, "post", SUPPLIERS, {
      name: "Paise Matter",
      creditLimit: 250000.55,
    });

    // DECIMAL(12,2), like every other money column here — G-07.
    const stored = await prisma.supplier.findUnique({
      where: { id: res.body.data.id },
      select: { creditLimit: true },
    });
    expect(stored.creditLimit.toFixed(2)).toBe("250000.55");
  });

  describe("the supplier code", () => {
    it("refuses a second supplier with the same code in one shop", async () => {
      const { token } = await signIn(app);
      await as(token, "post", SUPPLIERS, { name: "First", code: "SUP-001" });

      const res = await as(token, "post", SUPPLIERS, {
        name: "Second",
        code: "SUP-001",
      });

      // P2002 through the shared error middleware, not a hand-rolled check.
      expect(res.status).toBe(409);
    });

    it("lets two shops use the same code", async () => {
      const { token } = await signIn(app);
      await as(token, "post", SUPPLIERS, { name: "Mine", code: "SUP-001" });

      const other = await makeShop();
      const { token: theirs } = await signIn(app, "ADMIN", {
        shopId: other.id,
        email: "supplier-code-other@test.local",
      });

      // The uniqueness is per shop. A code is the shop's own reference, and
      // two pharmacies numbering their distributors from SUP-001 is normal.
      expect(
        (await as(theirs, "post", SUPPLIERS, { name: "Theirs", code: "SUP-001" }))
          .status,
      ).toBe(201);
    });

    // The trap the client-side payload builder exists to avoid: an empty
    // string is a *value*, so two blank codes would collide on the unique
    // index. NULLs are distinct, so the field has to be absent, not empty.
    it("lets any number of suppliers have no code at all", async () => {
      const { token } = await signIn(app);

      expect((await as(token, "post", SUPPLIERS, { name: "One" })).status).toBe(201);
      expect((await as(token, "post", SUPPLIERS, { name: "Two" })).status).toBe(201);
      expect((await as(token, "post", SUPPLIERS, { name: "Three" })).status).toBe(201);
    });
  });

  describe("validation", () => {
    it("rejects a PIN code that is not six digits", async () => {
      const { token } = await signIn(app);

      expect(
        (await as(token, "post", SUPPLIERS, { name: "X", pincode: "8000" })).status,
      ).toBe(400);
      expect(
        (await as(token, "post", SUPPLIERS, { name: "X", pincode: "80000A" }))
          .status,
      ).toBe(400);
    });

    it("keeps a leading zero, which a number column would eat", async () => {
      const { token } = await signIn(app);

      const res = await as(token, "post", SUPPLIERS, {
        name: "Kerala Distributor",
        pincode: "682001",
      });
      expect(res.body.data.pincode).toBe("682001");
    });

    it("refuses a negative credit limit", async () => {
      const { token } = await signIn(app);
      expect(
        (await as(token, "post", SUPPLIERS, { name: "X", creditLimit: -1 })).status,
      ).toBe(400);
    });

    it("still creates a supplier from a name alone", async () => {
      const { token } = await signIn(app);

      // The shape of the real workflow: a distributor is entered mid-call with
      // whatever is to hand and filled in later from the first invoice.
      expect((await as(token, "post", SUPPLIERS, { name: "Just A Name" })).status).toBe(
        201,
      );
    });
  });
});

describe("a medicine's primary supplier", () => {
  const medicineBody = (masters, over = {}) => ({
    name: "Dolo 650",
    genericName: "Paracetamol 650 mg",
    categoryId: masters.category.id,
    manufacturerId: masters.manufacturer.id,
    hsnCode: "30049099",
    packSize: "1*15",
    unit: "tablet",
    gstPercent: 12,
    isScheduledH: false,
    ...over,
  });

  it("records which distributor it is usually bought from", async () => {
    const { token } = await signIn(app);
    const masters = await makeMasters();

    const res = await as(
      token,
      "post",
      "/api/medicines",
      medicineBody(masters, { defaultSupplierId: masters.supplier.id }),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.defaultSupplier).toMatchObject({
      id: masters.supplier.id,
    });
  });

  it("treats an empty selection as no preference rather than an error", async () => {
    const { token } = await signIn(app);
    const masters = await makeMasters();

    // The select sends "" when cleared. That is "no preference", not a
    // malformed id.
    const res = await as(
      token,
      "post",
      "/api/medicines",
      medicineBody(masters, { defaultSupplierId: "" }),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.defaultSupplier).toBeNull();
  });

  it("can be cleared on an edit", async () => {
    const { token } = await signIn(app);
    const masters = await makeMasters();
    const created = await as(
      token,
      "post",
      "/api/medicines",
      medicineBody(masters, { defaultSupplierId: masters.supplier.id }),
    );

    const updated = await as(
      token,
      "put",
      `/api/medicines/${created.body.data.id}`,
      medicineBody(masters, { defaultSupplierId: "" }),
    );

    expect(updated.body.data.defaultSupplier).toBeNull();
  });

  // A preference is not history. Deleting the distributor should forget where
  // the shop used to reorder from, not refuse the deletion — while a *batch*
  // reference still blocks it, because that one records a real purchase.
  it("is cleared when the supplier is deleted, rather than blocking it", async () => {
    const { token } = await signIn(app);
    const masters = await makeMasters();
    const created = await as(
      token,
      "post",
      "/api/medicines",
      medicineBody(masters, { defaultSupplierId: masters.supplier.id }),
    );

    const deleted = await as(
      token,
      "delete",
      `${SUPPLIERS}/${masters.supplier.id}`,
    );
    expect(deleted.status).toBe(200);

    const after = await as(token, "get", `/api/medicines/${created.body.data.id}`);
    expect(after.body.data.defaultSupplier).toBeNull();
  });

  it("still refuses to delete a supplier that has stock against it", async () => {
    const { token } = await signIn(app);
    const { supplier } = await makeSellable();

    // The contrast with the test above: a batch is a purchase that happened.
    expect((await as(token, "delete", `${SUPPLIERS}/${supplier.id}`)).status).toBe(
      409,
    );
  });
});

/**
 * References in a request body have to belong to the caller's shop.
 *
 * The tenancy rule in this codebase puts `shopId` in the same `where` as `id`
 * on every scoped read and write. That covers the row being written and says
 * nothing about the rows it points at — so `POST /api/medicines` took a
 * `categoryId` from the body straight into `create`, and a foreign key only
 * asks whether a row exists, never whose it is.
 *
 * A foreign id answers 404, never 403: the alternative confirms the row exists
 * to somebody who cannot see it.
 */
describe("foreign references", () => {
  const otherShopMasters = async () => {
    const shop = await makeShop();
    return makeMasters({ shopId: shop.id });
  };

  it("refuses another shop's category", async () => {
    const { token } = await signIn(app);
    const mine = await makeMasters();
    const theirs = await otherShopMasters();

    const res = await as(token, "post", "/api/medicines", {
      name: "Leaky",
      categoryId: theirs.category.id,
      manufacturerId: mine.manufacturer.id,
      unit: "tablet",
      gstPercent: 12,
    });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Category not found");
  });

  it("refuses another shop's manufacturer", async () => {
    const { token } = await signIn(app);
    const mine = await makeMasters();
    const theirs = await otherShopMasters();

    const res = await as(token, "post", "/api/medicines", {
      name: "Leaky",
      categoryId: mine.category.id,
      manufacturerId: theirs.manufacturer.id,
      unit: "tablet",
      gstPercent: 12,
    });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Manufacturer not found");
  });

  it("refuses another shop's supplier as a primary supplier", async () => {
    const { token } = await signIn(app);
    const mine = await makeMasters();
    const theirs = await otherShopMasters();

    const res = await as(token, "post", "/api/medicines", {
      name: "Leaky",
      categoryId: mine.category.id,
      manufacturerId: mine.manufacturer.id,
      defaultSupplierId: theirs.supplier.id,
      unit: "tablet",
      gstPercent: 12,
    });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Supplier not found");
  });

  it("refuses a foreign reference on an edit too", async () => {
    const { token } = await signIn(app);
    const mine = await makeMasters();
    const theirs = await otherShopMasters();
    const created = await as(token, "post", "/api/medicines", {
      name: "Fine",
      categoryId: mine.category.id,
      manufacturerId: mine.manufacturer.id,
      unit: "tablet",
      gstPercent: 12,
    });

    const res = await as(token, "put", `/api/medicines/${created.body.data.id}`, {
      name: "Fine",
      categoryId: theirs.category.id,
      manufacturerId: mine.manufacturer.id,
      unit: "tablet",
      gstPercent: 12,
    });

    expect(res.status).toBe(404);
  });

  // `POST /api/inventory/batches` checked its medicineId and not its
  // supplierId, so a batch could name another shop's distributor and the
  // response's `supplier: { name }` would read it straight back.
  it("refuses another shop's supplier on a batch", async () => {
    const { token } = await signIn(app);
    const { medicine } = await makeSellable();
    const theirs = await otherShopMasters();

    const res = await as(token, "post", "/api/inventory/batches", {
      medicineId: medicine.id,
      supplierId: theirs.supplier.id,
      batchNumber: "B-LEAK",
      expiryDate: "2028-12-31",
      purchasePrice: 10,
      sellingPrice: 24.5,
      quantity: 10,
    });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Supplier not found");
  });

  it("lets the shop's own references through", async () => {
    const { token } = await signIn(app);
    const mine = await makeMasters();

    const res = await as(token, "post", "/api/medicines", {
      name: "Perfectly Fine",
      categoryId: mine.category.id,
      manufacturerId: mine.manufacturer.id,
      defaultSupplierId: mine.supplier.id,
      unit: "tablet",
      gstPercent: 12,
    });

    expect(res.status).toBe(201);
  });
});
