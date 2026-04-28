import { useEffect } from "react";
import api from "@/lib/api";
// ✅ Fix — use type-only import
import { useNotificationStore } from '@/store/notification.store'
import type { AppNotification } from '@/store/notification.store'

export const useNotifications = () => {
  const { setNotifications } = useNotificationStore();

  const fetchAlerts = async () => {
    try {
      const [expiringRes, lowStockRes] = await Promise.all([
        api.get("/api/inventory/batches/expiring?days=30"),
        api.get("/api/inventory/batches/low-stock?threshold=10"),
      ]);

      const expiring = expiringRes.data.data;
      const lowStock = lowStockRes.data.data;
      const notifications: AppNotification[] = [];

      // Expiring soon
      expiring.forEach(
        (batch: {
          id: string;
          medicine: { name: string };
          expiryDate: string;
          quantity: number;
        }) => {
          const daysLeft = Math.ceil(
            (new Date(batch.expiryDate).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24),
          );
          notifications.push({
            id: `exp-${batch.id}`,
            type: daysLeft <= 7 ? "danger" : "warning",
            title: daysLeft <= 7 ? "Expiring Very Soon!" : "Expiring Soon",
            message: `${batch.medicine.name} expires in ${daysLeft} days (${batch.quantity} units left)`,
            read: false,
            createdAt: new Date(),
          });
        },
      );

      // Low stock
      lowStock.forEach(
        (batch: {
          id: string;
          medicine: { name: string; unit: string };
          quantity: number;
        }) => {
          notifications.push({
            id: `low-${batch.id}`,
            type: "danger",
            title: "Low Stock Alert",
            message: `${batch.medicine.name} has only ${batch.quantity} ${batch.medicine.unit}s left`,
            read: false,
            createdAt: new Date(),
          });
        },
      );

      setNotifications(notifications);
    } catch {
      /* silent */
    }
  };

  useEffect(() => {
    fetchAlerts();
    // Refresh every 5 minutes
    const interval = setInterval(fetchAlerts, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);
};
