import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import MockAdapter from "axios-mock-adapter";
import api from "@/lib/api";
import { useNotifications } from "@/hooks/useNotifications";
import { useNotificationStore } from "@/store/notification.store";
import { createQueryWrapper } from "@/test/query-wrapper";

/**
 * docs/09 §5.6 — a batch expiring in 5 days is `danger`, one at 25 days is
 * `warning`.
 *
 * The severity threshold is 7 days, and it is derived on the client from the
 * expiry date rather than sent by the API. That makes it easy to change by
 * accident while the tray keeps rendering something plausible, which is exactly
 * the failure this pins down.
 */

let mock: MockAdapter;

const daysFromNow = (n: number) =>
  new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

const expiringBatch = (id: string, days: number) => ({
  id,
  medicine: { name: `Medicine ${id}`, unit: "tablet" },
  expiryDate: daysFromNow(days),
  quantity: 10,
});

type ExpiringStub = ReturnType<typeof expiringBatch>;
type LowStockStub = {
  id: string;
  medicine: { name: string; unit: string };
  quantity: number;
};

const stubAlerts = ({
  expiring = [],
  lowStock = [],
}: { expiring?: ExpiringStub[]; lowStock?: LowStockStub[] } = {}) => {
  mock
    .onGet("/api/reports/expiring?days=30")
    .reply(200, { success: true, data: expiring });
  mock
    .onGet("/api/reports/low-stock?threshold=10")
    .reply(200, { success: true, data: lowStock });
};

beforeEach(() => {
  mock = new MockAdapter(api);
  useNotificationStore.setState({ notifications: [], unreadCount: 0 });
});

afterEach(() => {
  mock.restore();
  vi.useRealTimers();
});

const notifications = () => useNotificationStore.getState().notifications;

describe("useNotifications — expiry severity", () => {
  it("marks a batch expiring in 5 days as danger", async () => {
    stubAlerts({ expiring: [expiringBatch("b1", 5)] });

    renderHook(() => useNotifications(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(notifications()).toHaveLength(1));
    expect(notifications()[0].type).toBe("danger");
    expect(notifications()[0].title).toBe("Expiring Very Soon!");
  });

  it("marks a batch expiring in 25 days as warning", async () => {
    stubAlerts({ expiring: [expiringBatch("b2", 25)] });

    renderHook(() => useNotifications(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(notifications()).toHaveLength(1));
    expect(notifications()[0].type).toBe("warning");
    expect(notifications()[0].title).toBe("Expiring Soon");
  });

  it("puts the boundary at 7 days inclusive", async () => {
    // 7 -> danger, 8 -> warning. Pinned because the threshold is a bare
    // comparison in the hook with nothing else asserting it.
    stubAlerts({
      expiring: [expiringBatch("at-7", 7), expiringBatch("at-8", 8)],
    });

    renderHook(() => useNotifications(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(notifications()).toHaveLength(2));
    const byId = Object.fromEntries(
      notifications().map((n) => [n.id, n.type]),
    );
    expect(byId["exp-at-7"]).toBe("danger");
    expect(byId["exp-at-8"]).toBe("warning");
  });

  it("marks every low-stock batch as danger regardless of expiry", async () => {
    stubAlerts({
      lowStock: [
        {
          id: "low1",
          medicine: { name: "Paracetamol", unit: "tablet" },
          quantity: 3,
        },
      ],
    });

    renderHook(() => useNotifications(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(notifications()).toHaveLength(1));
    expect(notifications()[0].type).toBe("danger");
    expect(notifications()[0].message).toContain("only 3");
  });

  it("reports both kinds together", async () => {
    stubAlerts({
      expiring: [expiringBatch("b3", 3)],
      lowStock: [
        { id: "low2", medicine: { name: "Amoxicillin", unit: "capsule" }, quantity: 1 },
      ],
    });

    renderHook(() => useNotifications(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(notifications()).toHaveLength(2));
    expect(notifications().map((n) => n.id)).toEqual(
      expect.arrayContaining(["exp-b3", "low-low2"]),
    );
  });

  it("stays silent when the alert endpoints fail", async () => {
    // The tray is ambient. A failed poll must not surface an error toast on
    // every screen, so the hook swallows it — asserted so the silence stays
    // deliberate rather than becoming an accident.
    mock.onGet(/batches/).reply(500);

    renderHook(() => useNotifications(), { wrapper: createQueryWrapper() });

    await new Promise((r) => setTimeout(r, 50));
    expect(notifications()).toHaveLength(0);
  });
});
