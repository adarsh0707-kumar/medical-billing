import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import prisma from "../../src/config/db.js";
import { buildApp, signIn } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

const customer = { name: "Ramesh Gupta", phone: "9876543210", address: "MG Road", age: 54, gender: "MALE" };

describe("customers", () => {
  it("is created from the billing screen by any role", async () => {
    const { token } = await signIn(app, "CASHIER");

    const res = await as(token, "post", "/api/billing/customers", customer);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: "Ramesh Gupta", age: 54, gender: "MALE" });
  });

  it("treats the phone number as the unique key", async () => {
    const { token } = await signIn(app);
    await as(token, "post", "/api/billing/customers", customer);

    const res = await as(token, "post", "/api/billing/customers", { ...customer, name: "Someone Else" });
    expect(res.status).toBe(409);
  });

  it("allows several customers with no phone number", async () => {
    const { token } = await signIn(app);

    expect((await as(token, "post", "/api/billing/customers", { name: "Walk In One" })).status).toBe(201);
    expect((await as(token, "post", "/api/billing/customers", { name: "Walk In Two" })).status).toBe(201);
  });

  it.each([
    ["an implausible age", { age: 151 }],
    ["a negative age", { age: -1 }],
    ["a one-character name", { name: "R" }],
    ["a malformed email", { email: "nope" }],
    ["an unknown gender", { gender: "UNKNOWN" }],
  ])("refuses %s", async (_label, override) => {
    const { token } = await signIn(app);
    expect((await as(token, "post", "/api/billing/customers", { ...customer, ...override })).status).toBe(400);
  });

  it("accepts an age sent as a string, as the form sends it", async () => {
    const { token } = await signIn(app);
    const res = await as(token, "post", "/api/billing/customers", { ...customer, age: "45" });

    expect(res.status).toBe(201);
    expect(res.body.data.age).toBe(45);
  });

  it("searches by name, phone and email", async () => {
    const { token } = await signIn(app);
    await as(token, "post", "/api/billing/customers", customer);
    await as(token, "post", "/api/billing/customers", { name: "Priya S", phone: "9111111111", email: "p@x.io" });

    expect((await as(token, "get", "/api/billing/customers?search=ramesh")).body.data).toHaveLength(1);
    expect((await as(token, "get", "/api/billing/customers?search=91111")).body.data).toHaveLength(1);
    expect((await as(token, "get", "/api/billing/customers?search=p@x")).body.data).toHaveLength(1);
  });

  it("reports a page count, the way the medicine and invoice lists do", async () => {
    const { token } = await signIn(app);
    for (const name of ["Page One", "Page Two", "Page Three"]) {
      await as(token, "post", "/api/billing/customers", { name });
    }

    const res = await as(token, "get", "/api/billing/customers?limit=2");

    // `pages` was the one field this endpoint left out while both other
    // paginated endpoints returned it, so a client paging all three had to
    // special-case this one. Asserted with toEqual rather than toMatchObject:
    // the point is that the shape matches exactly, extra keys included.
    expect(res.body.pagination).toEqual({ total: 3, page: 1, limit: 2, pages: 2 });
  });

  it("returns a customer with their recent invoices", async () => {
    const { token, user } = await signIn(app);
    const created = await as(token, "post", "/api/billing/customers", customer);
    await prisma.invoice.create({
      data: {
        invoiceNumber: "INV260101-0001",
        customerId: created.body.data.id,
        userId: user.id,
        subtotal: 100, cgst: 6, sgst: 6, totalAmount: 112,
      },
    });

    const res = await as(token, "get", `/api/billing/customers/${created.body.data.id}`);

    expect(res.body.data.invoices).toHaveLength(1);
    expect(res.body.data.invoices[0].totalAmount).toBe(112);
  });

  it("404s for an unknown customer", async () => {
    const { token } = await signIn(app);
    expect((await as(token, "get", "/api/billing/customers/nope")).status).toBe(404);
  });
});
