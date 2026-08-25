import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";

/**
 * The three master lists, as shared queries (G-16).
 *
 * Categories, manufacturers and suppliers were each fetched independently by
 * every tab that needed them — categories and manufacturers from two places,
 * suppliers from three. Every tab switch re-requested all of it, and each copy
 * could disagree with the others after an edit.
 *
 * As queries they are fetched once, shared by key, and invalidated together
 * when one of them is written to. Master data changes rarely, so it also gets a
 * longer staleness window than the default.
 */

/**
 * The minimum every master row has. Each hook is generic over it so a page can
 * supply its own richer type — Inventory's categories carry a `_count`, its
 * suppliers carry contact fields — without this module having to know about
 * them or the page having to cast.
 */
export interface Master {
  id: string;
  name: string;
}

// Masters are edited by hand, a few times a week at most. Five minutes is far
// inside "the shop has not restructured its catalogue since you opened the tab".
const MASTER_STALE_TIME = 5 * 60_000;

export const useCategories = <T extends Master = Master>() =>
  useQuery<T[]>({
    queryKey: ["categories"],
    queryFn: async ({ signal }) => {
      const res = await api.get("/api/inventory/categories", { signal });
      return res.data.data;
    },
    staleTime: MASTER_STALE_TIME,
    meta: { errorMessage: "Failed to fetch categories" },
  });

export const useManufacturers = <T extends Master = Master>() =>
  useQuery<T[]>({
    queryKey: ["manufacturers"],
    queryFn: async ({ signal }) => {
      const res = await api.get("/api/inventory/manufacturers", { signal });
      return res.data.data;
    },
    staleTime: MASTER_STALE_TIME,
    meta: { errorMessage: "Failed to fetch manufacturers" },
  });

export const useSuppliers = <T extends Master = Master>() =>
  useQuery<T[]>({
    queryKey: ["suppliers", ""],
    queryFn: async ({ signal }) => {
      const res = await api.get("/api/suppliers", { signal });
      return res.data.data;
    },
    staleTime: MASTER_STALE_TIME,
    meta: { errorMessage: "Failed to fetch suppliers" },
  });
