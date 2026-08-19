import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp, signIn, makeMedicine, makeBatch } from "../helpers/factory.js";

let app;
beforeAll(() => {
  app = buildApp();
});

const as = (token, method, path, body) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`).send(body);

describe.each([
  ["categories", "/api/inventory/categories"],
  ["manufacturers", "/api/inventory/manufacturers"],
])("%s", (_label, path) => {
  it("creates one and counts the medicines against it", async () => {
    const { token } = await signIn(app);

    expect((await as(token, "post", path, { name: "Analgesic" })).status).toBe(201);

    const list = await as(token, "get", path);
    expect(list.body.data[0]).toMatchObject({ name: "Analgesic", _count: { medicines: 0 } });
  });

  it("rejects a duplicate name with a conflict, naming the field", async () => {
    const { token } = await signIn(app);
    await as(token, "post", path, { name: "Analgesic" });

    const res = await as(token, "post", path, { name: "Analgesic" });

    expect(res.status).toBe(409);
    expect(res.body.field).toContain("name");
  });

  it("rejects a one-character name", async () => {
    const { token } = await signIn(app);
    expect((await as(token, "post", path, { name: "A" })).status).toBe(400);
  });

  it("deletes an unused one", async () => {
    const { token } = await signIn(app);
    const created = await as(token, "post", path, { name: "Spare" });

    expect((await as(token, "delete", `${path}/${created.body.data.id}`)).status).toBe(200);
  });
});

// Regression guard for G-12. These deletes used to throw an unmapped Prisma
// P2003 and surface as a 500, which tells the user nothing.
describe("deleting master data that is still in use", () => {
  it("refuses to delete a category with medicines, and says why", async () => {
    const { token } = await signIn(app);
    const { category } = await makeMedicine();

    const res = await as(token, "delete", `/api/inventory/categories/${category.id}`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/still in use/i);
  });

  it("refuses to delete a manufacturer with medicines", async () => {
    const { token } = await signIn(app);
    const { manufacturer } = await makeMedicine();

    const res = await as(token, "delete", `/api/inventory/manufacturers/${manufacturer.id}`);
    expect(res.status).toBe(409);
  });

  it("refuses to delete a supplier that has supplied stock", async () => {
    const { token } = await signIn(app);
    const { medicine, supplier } = await makeMedicine();
    await makeBatch({ medicineId: medicine.id, supplierId: supplier.id });

    const res = await as(token, "delete", `/api/inventory/suppliers/${supplier.id}`);
    expect(res.status).toBe(409);
  });
});

describe("suppliers", () => {
  const supplier = {
    name: "MedPlus Distributors",
    contactName: "Rahul",
    phone: "9876543210",
    email: "rahul@medplus.in",
    gstNumber: "27AABCU9603R1ZM",
  };

  it("creates and updates one", async () => {
    const { token } = await signIn(app);

    const created = await as(token, "post", "/api/inventory/suppliers", supplier);
    expect(created.status).toBe(201);

    const updated = await as(token, "put", `/api/inventory/suppliers/${created.body.data.id}`, {
      ...supplier,
      name: "MedPlus North",
    });
    expect(updated.body.data.name).toBe("MedPlus North");
  });

  it("accepts a blank email but not a malformed one", async () => {
    const { token } = await signIn(app);

    expect((await as(token, "post", "/api/inventory/suppliers", { ...supplier, email: "" })).status).toBe(201);
    expect((await as(token, "post", "/api/inventory/suppliers", { ...supplier, email: "nope" })).status).toBe(400);
  });

  it("searches by name and phone", async () => {
    const { token } = await signIn(app);
    await as(token, "post", "/api/inventory/suppliers", supplier);
    await as(token, "post", "/api/inventory/suppliers", { name: "Apollo Wholesale", phone: "9000000000" });

    expect((await as(token, "get", "/api/inventory/suppliers?search=apollo")).body.data).toHaveLength(1);
    expect((await as(token, "get", "/api/inventory/suppliers?search=98765")).body.data).toHaveLength(1);
  });

  it("404s for an unknown supplier", async () => {
    const { token } = await signIn(app);
    expect((await as(token, "get", "/api/inventory/suppliers/nope")).status).toBe(404);
  });
});
