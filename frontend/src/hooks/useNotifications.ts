import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { useNotificationStore } from "@/store/notification.store";
import type { AppNotification } from "@/store/notification.store";

/**
 * The alert bell's data (G-16).
 *
 * The store stays: it owns read/unread, which the server knows nothing about.
 * Only the fetching moved. The two queries share their cache keys with the Stock
 * Alerts panel in Reports, so opening that tab with the same 30-day window costs
 * nothing.
 */

const DAY_MS = 1000 * 60 * 60 * 24;
const REFRESH_MS = 5 * 60 * 1000;

interface ExpiringBatch {
  id: string;
  medicine: { name: string };
  expiryDate: string;
  quantity: number;
}

interface LowStockBatch {
  id: string;
  medicine: { name: string; unit: string };
  quantity: number;
}

export const useNotifications = () => {
  const setNotifications = useNotificationStore((s) => s.setNotifications);

  // Each query maps its own rows into notifications inside `queryFn`.
  //
  // That is where the clock belongs: `daysLeft` and `createdAt` are properties of
  // the moment the data was fetched, not of the moment React happened to render.
  // Computing them in a `useMemo` reads the clock during render, which is impure
  // and which `react-hooks/purity` correctly rejects — and it would also silently
  // re-date every notification on an unrelated re-render.
  const { data: expiringAlerts } = useQuery<AppNotification[]>({
    queryKey: ["batches", "expiring", 30],
    queryFn: async ({ signal }) => {
      const res = await api.get("/api/inventory/batches/expiring?days=30", {
        signal,
      });
      const now = Date.now();
      return (res.data.data as ExpiringBatch[]).map((batch) => {
        const daysLeft = Math.ceil(
          (new Date(batch.expiryDate).getTime() - now) / DAY_MS,
        );
        return {
          id: `exp-${batch.id}`,
          type: daysLeft <= 7 ? "danger" : "warning",
          title: daysLeft <= 7 ? "Expiring Very Soon!" : "Expiring Soon",
          message: `${batch.medicine.name} expires in ${daysLeft} days (${batch.quantity} units left)`,
          read: false,
          createdAt: new Date(now),
        };
      });
    },
    refetchInterval: REFRESH_MS,
    // The bell was silent on failure before and stays silent: a failed
    // background poll is not something to interrupt a sale with.
    meta: { errorMessage: null },
  });

  const { data: lowStockAlerts } = useQuery<AppNotification[]>({
    queryKey: ["batches", "low-stock", 10],
    queryFn: async ({ signal }) => {
      const res = await api.get("/api/inventory/batches/low-stock?threshold=10", {
        signal,
      });
      const now = new Date();
      return (res.data.data as LowStockBatch[]).map((batch) => ({
        id: `low-${batch.id}`,
        type: "danger" as const,
        title: "Low Stock Alert",
        message: `${batch.medicine.name} has only ${batch.quantity} ${batch.medicine.unit}s left`,
        read: false,
        createdAt: now,
      }));
    },
    refetchInterval: REFRESH_MS,
    meta: { errorMessage: null },
  });

  const notifications = useMemo<AppNotification[] | null>(
    () =>
      expiringAlerts && lowStockAlerts
        ? [...expiringAlerts, ...lowStockAlerts]
        : null,
    [expiringAlerts, lowStockAlerts],
  );

  // Publishing to the store is the one thing that has to be an effect: it writes
  // outside React's own state during render otherwise.
  //
  // It now runs only when the *data* changed. The old five-minute interval
  // rebuilt and republished the list unconditionally, which reset every
  // notification to unread — so dismissing one and waiting five minutes brought
  // it back. TanStack's structural sharing keeps the same array reference when a
  // poll returns identical rows, so the memo does not recompute and read state
  // survives.
  useEffect(() => {
    if (notifications) setNotifications(notifications);
  }, [notifications, setNotifications]);
};
