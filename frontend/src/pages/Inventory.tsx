import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCategories,
  useManufacturers,
  useSuppliers,
  useUnits,
} from "@/hooks/useMasters";
import { useDebounced } from "@/hooks/useDebounced";
import {
  Package,
  Plus,
  Search,
  Edit2,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  X,
  Filter,
  FlaskConical,
  Building2,
  Truck,
  Layers,
} from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import type {
  BatchInput,
  CategoryInput,
  ManufacturerInput,
} from "@/types/api.generated";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { TabSwitcher, type TabItem } from "@/components/layout/TabSwitcher";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ─── Types ─────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  _count?: { medicines: number };
}
interface Manufacturer {
  id: string;
  name: string;
  _count?: { medicines: number };
}
interface Supplier {
  id: string;
  name: string;
  /** The shop's own reference for this distributor — `SUP-001`. */
  code?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  gstNumber?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  drugLicenceNo?: string;
  paymentTerms?: string;
  deliveryDays?: string;
  creditLimit?: number;
  notes?: string;
}
interface Medicine {
  id: string;
  name: string;
  genericName?: string;
  unit: string;
  gstPercent: number;
  hsnCode?: string;
  packSize?: string;
  isScheduledH: boolean;
  isActive: boolean;
  category: Category;
  manufacturer: Manufacturer;
  /**
   * Where this medicine is usually bought — a preference, not a history.
   * The supplier on a *batch* records where one consignment came from, which
   * is the fact a recall follows; this is the one to reorder from.
   */
  defaultSupplier?: { id: string; name: string; code?: string } | null;
  totalStock?: number;
  sellingPrice?: number;
  nearestExpiry?: string;
}
interface Batch {
  id: string;
  batchNumber: string;
  expiryDate: string;
  mfgDate?: string | null;
  purchasePrice: number;
  sellingPrice: number;
  quantity: number;
  initialQty: number;
  medicine: { name: string; unit: string };
  supplier: { name: string };
}

// ─── Helpers ───────────────────────────────────────────

const formatINR = (v: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    v,
  );

const getDaysLeft = (date: string) =>
  Math.ceil((new Date(date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

/**
 * Suggestions, not the permitted set.
 *
 * These nine were an enum on the server until 2026-09-01, so a shop selling
 * vials, sachets, strips or tubes had to file them under "other" — and "other"
 * in the PACK column of a printed invoice tells a customer nothing. The server
 * now takes any short word and `GET /api/medicines/units` reports back the ones
 * this shop actually uses, which is what makes a unit typed once stay on the
 * list afterwards.
 */
const DEFAULT_UNITS = [
  "tablet",
  "capsule",
  "syrup",
  "injection",
  "cream",
  "drops",
  "powder",
  "inhaler",
  "other",
];

/**
 * The value of the "add a unit" row. A sentinel rather than an empty string,
 * because Radix treats "" as "nothing selected" and the row has to be
 * selectable. The dot cannot collide with a real unit: the server requires one
 * to start with a letter.
 */
const ADD_UNIT = ".add";

/**
 * "No preference" in the primary-supplier select.
 *
 * A sentinel for the same reason `ADD_UNIT` is one: Radix reads `""` as
 * "nothing selected" and refuses it as an item value, but clearing the
 * preference has to be a thing the operator can pick. It is translated back to
 * `""` on the way into the form, and the payload sends `null`.
 */
const NO_SUPPLIER = ".none";
const GST_RATES = [0, 5, 12, 18];

/**
 * The distributor card, as a form.
 *
 * Shared shape for the two places a supplier is edited — this tab and the
 * Suppliers page — so the two cannot offer different fields for one record.
 */
const EMPTY_SUPPLIER_FORM = {
  name: "",
  code: "",
  contactName: "",
  phone: "",
  email: "",
  gstNumber: "",
  address: "",
  city: "",
  state: "",
  pincode: "",
  drugLicenceNo: "",
  paymentTerms: "",
  deliveryDays: "",
  creditLimit: "",
  notes: "",
};

type SupplierForm = typeof EMPTY_SUPPLIER_FORM;

const supplierFormFrom = (s: Supplier): SupplierForm => ({
  name: s.name,
  code: s.code || "",
  contactName: s.contactName || "",
  phone: s.phone || "",
  email: s.email || "",
  gstNumber: s.gstNumber || "",
  address: s.address || "",
  city: s.city || "",
  state: s.state || "",
  pincode: s.pincode || "",
  drugLicenceNo: s.drugLicenceNo || "",
  paymentTerms: s.paymentTerms || "",
  deliveryDays: s.deliveryDays || "",
  creditLimit: s.creditLimit != null ? String(s.creditLimit) : "",
  notes: s.notes || "",
});

/**
 * An untouched field is **omitted**, not sent as `""`.
 *
 * `code` is unique per shop, and an empty string is a value: two suppliers
 * saved with a blank code collide on the unique index, and the second comes
 * back 409 over a field nobody filled in. Postgres treats NULLs as distinct,
 * so the absent case has to actually be absent.
 *
 * `creditLimit` leaves as a number — it is typed into a text box, and a blank
 * one means no limit rather than zero.
 */
const supplierPayload = (f: SupplierForm) => {
  const { creditLimit, ...rest } = f;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value.trim() !== "") payload[key] = value.trim();
  }
  if (creditLimit.trim() !== "") payload.creditLimit = Number(creditLimit);
  return payload;
};

// ─── Reusable Form Field ────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-slate-300 text-sm">{label}</Label>
      {children}
    </div>
  );
}

const inputCls =
  "bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500 h-9";

// ═══════════════════════════════════════════════════════
// MEDICINES TAB
// ═══════════════════════════════════════════════════════

function MedicinesTab() {

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [page, setPage] = useState(1);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Medicine | null>(null);
  const [form, setForm] = useState({
    name: "",
    genericName: "",
    categoryId: "",
    manufacturerId: "",
    hsnCode: "",
    packSize: "",
    unit: "tablet",
    gstPercent: 12,
    isScheduledH: false,
    defaultSupplierId: "",
  });
  const [submitting, setSubmitting] = useState(false);
  // The free-text unit box, open only while a new one is being typed.
  const [addingUnit, setAddingUnit] = useState(false);
  // What the unit was before that box opened, so cancelling restores it
  // rather than leaving the field empty. A ref, not state: nothing renders
  // from it, and it must not cause one.
  const unitBeforeAdd = useRef("tablet");

  const queryClient = useQueryClient();

  const { data: usedUnits = [] } = useUnits();

  /**
   * The suggestions, plus every unit this shop already uses, plus whatever is
   * on the medicine being edited — that last one matters because a medicine
   * saved with a unit that has since gone out of use would otherwise open
   * with an empty Unit box and lose it on the next save.
   */
  const unitOptions = useMemo(
    () =>
      Array.from(
        new Set([...DEFAULT_UNITS, ...usedUnits, form.unit].filter(Boolean)),
      ).sort(),
    [usedUnits, form.unit],
  );

  const { data, isLoading: loading } = useQuery({
    queryKey: ["medicines", page, search, categoryFilter],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        page: String(page),
        limit: "12",
        ...(search && { search }),
        ...(categoryFilter !== "all" && { categoryId: categoryFilter }),
      });
      const res = await api.get(`/api/medicines?${params}`, {
        signal,
      });
      return {
        medicines: res.data.data as Medicine[],
        totalPages: res.data.pagination.pages as number,
        total: res.data.pagination.total as number,
      };
    },
    placeholderData: (previous) => previous,
    meta: { errorMessage: "Failed to fetch medicines" },
  });

  const medicines = data?.medicines ?? [];
  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;

  // Shared with the Batches and Masters tabs — one request between them now
  // rather than one per tab, and they cannot disagree after an edit.
  const { data: categories = [] } = useCategories<Category>();
  const { data: manufacturers = [] } = useManufacturers<Manufacturer>();
  // For the primary-supplier select. The shared query, so the Batches tab and
  // this form cannot disagree about the distributor list.
  const { data: suppliers = [] } = useSuppliers<Supplier>();

  const refreshMedicines = () =>
    queryClient.invalidateQueries({ queryKey: ["medicines"] });

  const openAdd = () => {
    setEditing(null);
    setAddingUnit(false);
    unitBeforeAdd.current = "tablet";
    setForm({
      name: "",
      genericName: "",
      categoryId: "",
      manufacturerId: "",
      hsnCode: "",
      packSize: "",
      unit: "tablet",
      gstPercent: 12,
      isScheduledH: false,
      defaultSupplierId: "",
    });
    setShowForm(true);
  };

  const openEdit = (med: Medicine) => {
    setEditing(med);
    setAddingUnit(false);
    unitBeforeAdd.current = med.unit;
    setForm({
      name: med.name,
      genericName: med.genericName || "",
      categoryId: med.category.id,
      manufacturerId: med.manufacturer.id,
      hsnCode: med.hsnCode || "",
      packSize: med.packSize || "",
      unit: med.unit,
      gstPercent: med.gstPercent,
      isScheduledH: med.isScheduledH,
      defaultSupplierId: med.defaultSupplier?.id ?? "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // The server lower-cases and trims the unit, and would otherwise accept a
    // blank one only to fail validation. Doing it here keeps the value the
    // form sends identical to the value that comes back, so the select does
    // not briefly show "Vial" for a medicine stored as "vial".
    const unit = form.unit.trim().toLowerCase();
    if (!unit) {
      toast.error("Give the medicine a unit");
      return;
    }
    const body = { ...form, unit };

    setSubmitting(true);
    try {
      if (editing) {
        await api.put(`/api/medicines/${editing.id}`, body);
        toast.success("Medicine updated!");
      } else {
        await api.post("/api/medicines", body);
        toast.success("Medicine added!");
      }
      setShowForm(false);
      setAddingUnit(false);
      refreshMedicines();
      // A unit typed for the first time is only a suggestion once this list
      // is refetched — this is the half that makes "add a unit" stick.
      queryClient.invalidateQueries({ queryKey: ["medicine-units"] });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      toast.error(e.response?.data?.message || "Failed to save");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (med: Medicine) => {
    if (!confirm(`Delete ${med.name}?`)) return;
    try {
      await api.delete(`/api/medicines/${med.id}`);
      toast.success("Medicine deleted");
      refreshMedicines();
    } catch {
      toast.error("Failed to delete");
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search medicines..."
            className={`pl-9 ${inputCls}`}
          />
        </div>
        <Select
          value={categoryFilter}
          onValueChange={(v) => {
            setCategoryFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44 bg-slate-700 border-slate-600 text-slate-100 h-9">
            <Filter className="w-3.5 h-3.5 mr-2 text-slate-400" />
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent className="bg-slate-800 border-slate-700">
            <SelectItem value="all" className="text-slate-100 focus:bg-slate-700">
              All Categories
            </SelectItem>
            {categories.map((c) => (
              <SelectItem
                key={c.id}
                value={c.id}
                className="text-slate-100 focus:bg-slate-700"
              >
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge className="bg-slate-700 text-slate-300">{total} medicines</Badge>
        <Button
          onClick={openAdd}
          className="bg-teal-600 hover:bg-teal-500 text-black h-9 ml-auto"
        >
          <Plus className="w-4 h-4 mr-1" /> Add Medicine
        </Button>
      </div>

      {/* Table */}
      <Card className="bg-slate-800 border-slate-700">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Medicine</th>
                  <th className="text-left px-4 py-3">Category</th>
                  <th className="text-left px-4 py-3">Manufacturer</th>
                  <th className="text-center px-4 py-3">Unit</th>
                  <th className="text-center px-4 py-3">GST</th>
                  <th className="text-right px-4 py-3">Stock</th>
                  <th className="text-right px-4 py-3">Price</th>
                  <th className="text-center px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {loading ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="py-16 text-center text-slate-500"
                    >
                      <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                      Loading medicines...
                    </td>
                  </tr>
                ) : medicines.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="py-16 text-center text-slate-500"
                    >
                      <Package className="w-10 h-10 mx-auto mb-2 opacity-20" />
                      No medicines found
                    </td>
                  </tr>
                ) : (
                  medicines.map((med) => (
                    <tr
                      key={med.id}
                      className="hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div>
                            <p className="text-white font-medium">{med.name}</p>
                            {med.genericName && (
                              <p className="text-slate-500 text-xs">
                                {med.genericName}
                              </p>
                            )}
                          </div>
                          {med.isScheduledH && (
                            <Badge className="bg-red-900/50 text-red-400 text-xs px-1.5 py-0">
                              H
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge className="bg-slate-700 text-slate-300 text-xs">
                          {med.category.name}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs">
                        {med.manufacturer.name}
                      </td>
                      <td className="px-4 py-3 text-center text-slate-400 text-xs capitalize">
                        {med.unit}
                      </td>
                      <td className="px-4 py-3 text-center text-slate-400 text-xs">
                        {med.gstPercent}%
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={`font-bold text-sm ${
                            (med.totalStock || 0) <= 10
                              ? "text-red-400"
                              : (med.totalStock || 0) <= 20
                                ? "text-yellow-400"
                                : "text-teal-400"
                          }`}
                        >
                          {med.totalStock || 0}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300 text-sm">
                        {med.sellingPrice ? formatINR(med.sellingPrice) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            aria-label="Edit medicine"
                            onClick={() => openEdit(med)}
                            className="p-1.5 rounded-md text-slate-400 hover:text-teal-400 hover:bg-slate-700 transition-colors"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            aria-label="Delete medicine"
                            onClick={() => handleDelete(med)}
                            className="p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700">
              <p className="text-slate-500 text-xs">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={page === 1}
                  className="border-slate-600 text-slate-300 hover:bg-slate-700 h-8 w-8 p-0"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page === totalPages}
                  className="border-slate-600 text-slate-300 hover:bg-slate-700 h-8 w-8 p-0"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Medicine Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Medicine" : "Add New Medicine"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Medicine Name *">
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  placeholder="e.g. Amoxicillin 500mg"
                  className={inputCls}
                />
              </Field>
              <Field label="Generic Name">
                <Input
                  value={form.genericName}
                  onChange={(e) =>
                    setForm({ ...form, genericName: e.target.value })
                  }
                  placeholder="e.g. Amoxicillin"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category *">
                <Select
                  value={form.categoryId}
                  onValueChange={(v) => setForm({ ...form, categoryId: v })}
                >
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-slate-100 h-9">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    {categories.map((c) => (
                      <SelectItem
                        key={c.id}
                        value={c.id}
                        className="text-slate-100 focus:bg-slate-700"
                      >
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Manufacturer *">
                <Select
                  value={form.manufacturerId}
                  onValueChange={(v) => setForm({ ...form, manufacturerId: v })}
                >
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-slate-100 h-9">
                    <SelectValue placeholder="Select manufacturer" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    {manufacturers.map((m) => (
                      <SelectItem
                        key={m.id}
                        value={m.id}
                        className="text-slate-100 focus:bg-slate-700"
                      >
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Unit *">
                {addingUnit ? (
                  <div className="flex items-center gap-1">
                    <Input
                      autoFocus
                      value={form.unit}
                      onChange={(e) =>
                        setForm({ ...form, unit: e.target.value })
                      }
                      onKeyDown={(e) => {
                        // Enter confirms the unit rather than submitting the
                        // whole medicine — the form is still half-filled at
                        // this point and submitting it would be a 400.
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (form.unit.trim()) setAddingUnit(false);
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setForm({ ...form, unit: unitBeforeAdd.current });
                          setAddingUnit(false);
                        }
                      }}
                      maxLength={20}
                      placeholder="e.g. vial"
                      aria-label="New unit"
                      className={`${inputCls} h-9`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setForm({ ...form, unit: unitBeforeAdd.current });
                        setAddingUnit(false);
                      }}
                      aria-label="Cancel new unit"
                      className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-700"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <Select
                    value={form.unit}
                    onValueChange={(v) => {
                      if (v === ADD_UNIT) {
                        // Remember what was selected, so cancelling puts it
                        // back rather than leaving the field empty.
                        unitBeforeAdd.current = form.unit;
                        setForm({ ...form, unit: "" });
                        setAddingUnit(true);
                        return;
                      }
                      setForm({ ...form, unit: v });
                    }}
                  >
                    {/* Named explicitly: `Field` draws its label as plain
                        text with no `htmlFor`, so the control itself carries
                        nothing a screen reader — or a test — can address it
                        by. */}
                    <SelectTrigger
                      aria-label="Unit"
                      className="bg-slate-700 border-slate-600 text-slate-100 h-9"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-700">
                      {unitOptions.map((u) => (
                        <SelectItem
                          key={u}
                          value={u}
                          className="text-slate-100 focus:bg-slate-700 capitalize"
                        >
                          {u}
                        </SelectItem>
                      ))}
                      <SelectItem
                        value={ADD_UNIT}
                        className="text-teal-400 focus:bg-slate-700"
                      >
                        + Add a unit…
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label="GST % *">
                <Select
                  value={String(form.gstPercent)}
                  onValueChange={(v) =>
                    setForm({ ...form, gstPercent: Number(v) })
                  }
                >
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-slate-100 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    {GST_RATES.map((r) => (
                      <SelectItem
                        key={r}
                        value={String(r)}
                        className="text-slate-100 focus:bg-slate-700"
                      >
                        {r}%
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="HSN Code">
                <Input
                  value={form.hsnCode}
                  onChange={(e) =>
                    setForm({ ...form, hsnCode: e.target.value })
                  }
                  placeholder="30041011"
                  className={inputCls}
                />
              </Field>
              {/* Printed as PACK on the invoice: the label off the carton, not
                  a quantity — "1*15ML" for a bottle, "1*10" for a strip. */}
              <Field label="Pack Size">
                <Input
                  value={form.packSize}
                  onChange={(e) =>
                    setForm({ ...form, packSize: e.target.value })
                  }
                  placeholder="1*10"
                  className={inputCls}
                />
              </Field>
            </div>
            {/* Who this is usually reordered from. A preference, so it is
                clearable — and separate from the supplier recorded on each
                batch, which is where a consignment actually came from. */}
            <Field label="Primary Supplier">
              <Select
                value={form.defaultSupplierId || NO_SUPPLIER}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    defaultSupplierId: v === NO_SUPPLIER ? "" : v,
                  })
                }
              >
                <SelectTrigger
                  aria-label="Primary Supplier"
                  className="bg-slate-700 border-slate-600 text-slate-100 h-9"
                >
                  <SelectValue placeholder="No preference" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  <SelectItem
                    value={NO_SUPPLIER}
                    className="text-slate-400 focus:bg-slate-700"
                  >
                    No preference
                  </SelectItem>
                  {suppliers.map((sup) => (
                    <SelectItem
                      key={sup.id}
                      value={sup.id}
                      className="text-slate-100 focus:bg-slate-700"
                    >
                      {sup.code ? `${sup.code} · ${sup.name}` : sup.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="schedH"
                checked={form.isScheduledH}
                onChange={(e) =>
                  setForm({ ...form, isScheduledH: e.target.checked })
                }
                className="w-4 h-4 rounded accent-teal-500"
              />
              <label htmlFor="schedH" className="text-slate-300 text-sm">
                Schedule H Drug (requires prescription)
              </label>
            </div>
            <Separator className="bg-slate-700" />
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowForm(false)}
                className="border-slate-600 text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-teal-600 hover:bg-teal-500 text-black"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
                {editing ? "Update" : "Add Medicine"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// BATCHES TAB
// ═══════════════════════════════════════════════════════

function BatchesTab() {
  const [filter, setFilter] = useState<"all" | "expiring" | "low">("all");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [medSearch, setMedSearch] = useState("");
  const [form, setForm] = useState({
    medicineId: "",
    medicineName: "",
    supplierId: "",
    batchNumber: "",
    expiryDate: "",
    mfgDate: "",
    purchasePrice: "",
    sellingPrice: "",
    mrp: "",
    quantity: "",
  });

  const [batchPage, setBatchPage] = useState(1);

  const queryClient = useQueryClient();

  const { data, isLoading: loading } = useQuery({
    queryKey: ["batches", "list", batchPage, filter],
    queryFn: async ({ signal }) => {
      // Paginated since 2026-08-20. Unfiltered this endpoint used to return
      // every batch in the shop — 8 MB and about a second and a half at 25,000
      // rows — to render one screen.
      const params = new URLSearchParams({
        page: String(batchPage),
        limit: "20",
        ...(filter === "expiring" && { expiringSoon: "true" }),
        ...(filter === "low" && { lowStock: "true" }),
      });
      const res = await api.get(`/api/inventory/batches?${params}`, { signal });
      return {
        batches: res.data.data as Batch[],
        totalPages: (res.data.pagination?.pages ?? 1) as number,
        total: (res.data.pagination?.total ?? res.data.data.length) as number,
      };
    },
    placeholderData: (previous) => previous,
    meta: { errorMessage: "Failed to fetch batches" },
  });

  const batches = data?.batches ?? [];
  const batchTotalPages = data?.totalPages ?? 1;
  const batchTotal = data?.total ?? 0;

  const { data: suppliers = [] } = useSuppliers<Supplier>();

  // Medicine search for the batch form.
  //
  // The debounce is still a `useState` + effect pair because it debounces *input*
  // rather than fetching: the query below is keyed on the settled term, so an
  // abandoned keystroke's request is cancelled rather than racing the next one.
  const debouncedMedSearch = useDebounced(medSearch, 300);

  const { data: medMatches = [] } = useQuery<Medicine[]>({
    queryKey: ["medicine-search", debouncedMedSearch],
    enabled: debouncedMedSearch.length >= 2,
    queryFn: async ({ signal }) => {
      const res = await api.get(
        `/api/medicines?search=${debouncedMedSearch}&limit=10`,
        { signal },
      );
      return res.data.data;
    },
    meta: { errorMessage: "Failed to search medicines" },
  });

  // Read off the live input, not the debounced one. Clearing the box has to empty
  // the dropdown immediately; the cached results for the term the user just
  // erased are still under the previous key for another 300ms.
  const medResults = medSearch.length >= 2 ? medMatches : [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      // Typed against `batchSchema` (NFR-22). This is the payload the `mfgDate`
      // bug lived in (G-04): the field is optional in the contract, so the type
      // permits omitting it and forbids sending it as `""`.
      const payload: BatchInput = {
        medicineId: form.medicineId,
        supplierId: form.supplierId,
        batchNumber: form.batchNumber,
        expiryDate: form.expiryDate,
        ...(form.mfgDate ? { mfgDate: form.mfgDate } : {}),
        purchasePrice: Number(form.purchasePrice),
        sellingPrice: Number(form.sellingPrice),
        ...(form.mrp !== "" && { mrp: Number(form.mrp) }),
        quantity: Number(form.quantity),
      };
      await api.post("/api/inventory/batches", payload);
      toast.success("Batch added to stock!");
      setShowForm(false);
      setForm({
        medicineId: "",
        medicineName: "",
        supplierId: "",
        batchNumber: "",
        expiryDate: "",
        mfgDate: "",
        purchasePrice: "",
        sellingPrice: "",
        mrp: "",
        quantity: "",
      });
      queryClient.invalidateQueries({ queryKey: ["batches"] });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      toast.error(e.response?.data?.message || "Failed to add batch");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg overflow-hidden border border-slate-700">
          {(["all", "expiring", "low"] as const).map((f) => (
            <button
              key={f}
              onClick={() => {
                setFilter(f);
                setBatchPage(1);
              }}
              className={`px-4 py-2 text-sm font-medium transition-colors capitalize ${
                filter === f
                  ? "bg-teal-600 text-black"
                  : "bg-slate-800 text-slate-400 hover:text-white"
              }`}
            >
              {f === "all"
                ? "All Batches"
                : f === "expiring"
                  ? "⚠ Expiring"
                  : "📉 Low Stock"}
            </button>
          ))}
        </div>
        <Badge className="bg-slate-700 text-slate-300">
          {batches.length} batches
        </Badge>
        <Button
          onClick={() => setShowForm(true)}
          className="bg-teal-600 hover:bg-teal-500 text-black h-9 ml-auto"
        >
          <Plus className="w-4 h-4 mr-1" /> Add Stock
        </Button>
      </div>

      {/* Batches Table */}
      <Card className="bg-slate-800 border-slate-700">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Medicine</th>
                  <th className="text-left px-4 py-3">Batch No</th>
                  <th className="text-left px-4 py-3">Supplier</th>
                  <th className="text-center px-4 py-3">Expiry</th>
                  <th className="text-right px-4 py-3">Qty</th>
                  <th className="text-right px-4 py-3">Buy Price</th>
                  <th className="text-right px-4 py-3">Sell Price</th>
                  <th className="text-right px-4 py-3">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {loading ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="py-16 text-center text-slate-500"
                    >
                      <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                      Loading batches...
                    </td>
                  </tr>
                ) : batches.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="py-16 text-center text-slate-500"
                    >
                      <Layers className="w-10 h-10 mx-auto mb-2 opacity-20" />
                      No batches found
                    </td>
                  </tr>
                ) : (
                  batches.map((batch) => {
                    const daysLeft = getDaysLeft(batch.expiryDate);
                    const margin = (
                      ((batch.sellingPrice - batch.purchasePrice) /
                        batch.purchasePrice) *
                      100
                    ).toFixed(1);
                    return (
                      <tr
                        key={batch.id}
                        className="hover:bg-slate-700/30 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <p className="text-white font-medium">
                            {batch.medicine.name}
                          </p>
                          <p className="text-slate-500 text-xs">
                            {batch.medicine.unit}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-slate-300 font-mono text-xs">
                          {batch.batchNumber}
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs">
                          {batch.supplier.name}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Badge
                            className={`text-xs ${
                              daysLeft <= 0
                                ? "bg-red-900 text-red-300"
                                : daysLeft <= 30
                                  ? "bg-yellow-900 text-yellow-300"
                                  : "bg-slate-700 text-slate-300"
                            }`}
                          >
                            {daysLeft <= 0 ? "Expired" : `${daysLeft}d`}
                          </Badge>
                          <p className="text-slate-500 text-xs mt-0.5">
                            {new Date(batch.expiryDate).toLocaleDateString(
                              "en-IN",
                            )}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={`font-bold ${
                              batch.quantity <= 10
                                ? "text-red-400"
                                : batch.quantity <= 20
                                  ? "text-yellow-400"
                                  : "text-teal-400"
                            }`}
                          >
                            {batch.quantity}
                          </span>
                          <p className="text-slate-500 text-xs">
                            /{batch.initialQty}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-right text-slate-400 text-sm">
                          {formatINR(batch.purchasePrice)}
                        </td>
                        <td className="px-4 py-3 text-right text-white font-medium text-sm">
                          {formatINR(batch.sellingPrice)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Badge className="bg-green-900/50 text-green-400 text-xs">
                            +{margin}%
                          </Badge>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {batchTotalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700">
              <p className="text-slate-400 text-sm">
                Page {batchPage} of {batchTotalPages} · {batchTotal} batches
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="border-slate-600 text-slate-300"
                  onClick={() => setBatchPage((p) => p - 1)}
                  disabled={batchPage === 1}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-slate-600 text-slate-300"
                  onClick={() => setBatchPage((p) => p + 1)}
                  disabled={batchPage === batchTotalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Batch Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle>Add New Stock Batch</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3 mt-2">
            {/* Medicine Search */}
            <Field label="Medicine *">
              {form.medicineName ? (
                <div className="flex items-center justify-between bg-teal-900/30 border border-teal-800 rounded-lg px-3 py-2">
                  <span className="text-white text-sm">
                    {form.medicineName}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setForm({ ...form, medicineId: "", medicineName: "" })
                    }
                  >
                    <X className="w-4 h-4 text-slate-400 hover:text-red-400" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <Input
                    value={medSearch}
                    onChange={(e) => setMedSearch(e.target.value)}
                    placeholder="Search medicine..."
                    className={`pl-9 ${inputCls}`}
                  />
                  {medResults.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-slate-700 border border-slate-600 rounded-lg overflow-hidden z-10 max-h-40 overflow-y-auto">
                      {medResults.map((m: Medicine) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => {
                            setForm({
                              ...form,
                              medicineId: m.id,
                              medicineName: m.name,
                            });
                            setMedSearch("");
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-slate-600 text-white text-sm"
                        >
                          {m.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Field>

            <Field label="Supplier *">
              <Select
                value={form.supplierId}
                onValueChange={(v) => setForm({ ...form, supplierId: v })}
              >
                <SelectTrigger className="bg-slate-700 border-slate-600 text-slate-100 h-9">
                  <SelectValue placeholder="Select supplier" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  {suppliers.map((s) => (
                    <SelectItem
                      key={s.id}
                      value={s.id}
                      className="text-slate-100 focus:bg-slate-700"
                    >
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Batch Number *">
                <Input
                  value={form.batchNumber}
                  onChange={(e) =>
                    setForm({ ...form, batchNumber: e.target.value })
                  }
                  required
                  placeholder="e.g. BATCH001"
                  className={inputCls}
                />
              </Field>
              <Field label="Expiry Date *">
                <Input
                  type="date"
                  value={form.expiryDate}
                  onChange={(e) =>
                    setForm({ ...form, expiryDate: e.target.value })
                  }
                  required
                  className={inputCls}
                />
              </Field>
              <Field label="Mfg Date">
                <Input
                  type="date"
                  value={form.mfgDate}
                  onChange={(e) => setForm({ ...form, mfgDate: e.target.value })}
                  max={form.expiryDate || undefined}
                  className={inputCls}
                />
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Field label="Purchase Price *">
                <Input
                  type="number"
                  step="0.01"
                  value={form.purchasePrice}
                  onChange={(e) =>
                    setForm({ ...form, purchasePrice: e.target.value })
                  }
                  required
                  placeholder="₹0.00"
                  className={inputCls}
                />
              </Field>
              <Field label="Selling Price *">
                <Input
                  type="number"
                  step="0.01"
                  value={form.sellingPrice}
                  onChange={(e) =>
                    setForm({ ...form, sellingPrice: e.target.value })
                  }
                  required
                  placeholder="₹0.00"
                  className={inputCls}
                />
              </Field>
              {/* Printed as MRP. Per batch, because the same product is
                  repriced between print runs. Blank prints no MRP for the
                  line, rather than repeating the selling price as though the
                  two were the same figure. */}
              <Field label="MRP">
                <Input
                  type="number"
                  step="0.01"
                  value={form.mrp}
                  onChange={(e) => setForm({ ...form, mrp: e.target.value })}
                  placeholder="₹0.00 (optional)"
                  className={inputCls}
                />
              </Field>
              <Field label="Quantity *">
                <Input
                  type="number"
                  value={form.quantity}
                  onChange={(e) =>
                    setForm({ ...form, quantity: e.target.value })
                  }
                  required
                  placeholder="0"
                  className={inputCls}
                />
              </Field>
            </div>

            <Separator className="bg-slate-700" />
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowForm(false)}
                className="border-slate-600 text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  submitting ||
                  !form.medicineId ||
                  !form.supplierId ||
                  !form.batchNumber ||
                  !form.expiryDate ||
                  !form.purchasePrice ||
                  !form.sellingPrice ||
                  !form.quantity
                }
                className="bg-teal-600 hover:bg-teal-500 text-black"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
                Add Stock
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// CATEGORIES TAB
// ═══════════════════════════════════════════════════════

function CategoriesTab() {
  const [catName, setCatName] = useState("");
  const [mfrName, setMfrName] = useState("");
  const [submittingCat, setSubmittingCat] = useState(false);
  const [submittingMfr, setSubmittingMfr] = useState(false);

  const queryClient = useQueryClient();

  // The same two queries the Medicines tab uses. Switching tabs no longer
  // refetches them, and adding a category here updates the medicine form's
  // dropdown without either tab knowing about the other.
  const { data: categories = [], isLoading: catLoading } = useCategories<Category>();
  const { data: manufacturers = [], isLoading: mfrLoading } = useManufacturers<Manufacturer>();
  const loading = catLoading || mfrLoading;

  const fetchAll = () => {
    queryClient.invalidateQueries({ queryKey: ["categories"] });
    queryClient.invalidateQueries({ queryKey: ["manufacturers"] });
  };

  const addCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingCat(true);
    try {
      await api.post("/api/inventory/categories", {
        name: catName,
      } satisfies CategoryInput);
      toast.success("Category added!");
      setCatName("");
      fetchAll();
    } catch {
      toast.error("Failed to add category");
    } finally {
      setSubmittingCat(false);
    }
  };

  const addManufacturer = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingMfr(true);
    try {
      await api.post("/api/inventory/manufacturers", {
        name: mfrName,
      } satisfies ManufacturerInput);
      toast.success("Manufacturer added!");
      setMfrName("");
      fetchAll();
    } catch {
      toast.error("Failed to add manufacturer");
    } finally {
      setSubmittingMfr(false);
    }
  };

  const deleteCategory = async (id: string) => {
    try {
      await api.delete(`/api/inventory/categories/${id}`);
      toast.success("Category deleted");
      fetchAll();
    } catch {
      toast.error("Cannot delete — medicines exist in this category");
    }
  };

  const deleteManufacturer = async (id: string) => {
    try {
      await api.delete(`/api/inventory/manufacturers/${id}`);
      toast.success("Manufacturer deleted");
      fetchAll();
    } catch {
      toast.error("Cannot delete — medicines exist for this manufacturer");
    }
  };

  if (loading)
    return (
      <div className="flex items-center justify-center h-40 text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
      </div>
    );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Categories */}
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="py-3 px-4 border-b border-slate-700">
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-teal-400" />
            Categories ({categories.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          <form onSubmit={addCategory} className="flex gap-2">
            <Input
              value={catName}
              onChange={(e) => setCatName(e.target.value)}
              placeholder="Category name"
              required
              className={`flex-1 ${inputCls}`}
            />
            <Button
              type="submit"
              disabled={submittingCat}
              className="bg-teal-600 hover:bg-teal-500 text-black h-9 shrink-0"
            >
              {submittingCat ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
            </Button>
          </form>
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {categories.map((cat) => (
              <div
                key={cat.id}
                className="flex items-center justify-between px-3 py-2 bg-slate-700/50 rounded-lg group"
              >
                <div>
                  <p className="text-white text-sm">{cat.name}</p>
                  <p className="text-slate-500 text-xs">
                    {cat._count?.medicines || 0} medicines
                  </p>
                </div>
                <button
                  onClick={() => deleteCategory(cat.id)}
                  className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Manufacturers */}
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="py-3 px-4 border-b border-slate-700">
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <Building2 className="w-4 h-4 text-blue-400" />
            Manufacturers ({manufacturers.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          <form onSubmit={addManufacturer} className="flex gap-2">
            <Input
              value={mfrName}
              onChange={(e) => setMfrName(e.target.value)}
              placeholder="Manufacturer name"
              required
              className={`flex-1 ${inputCls}`}
            />
            <Button
              type="submit"
              disabled={submittingMfr}
              className="bg-blue-600 hover:bg-blue-500 text-black h-9 shrink-0"
            >
              {submittingMfr ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
            </Button>
          </form>
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {manufacturers.map((mfr) => (
              <div
                key={mfr.id}
                className="flex items-center justify-between px-3 py-2 bg-slate-700/50 rounded-lg group"
              >
                <div>
                  <p className="text-white text-sm">{mfr.name}</p>
                  <p className="text-slate-500 text-xs">
                    {mfr._count?.medicines || 0} medicines
                  </p>
                </div>
                <button
                  onClick={() => deleteManufacturer(mfr.id)}
                  className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// SUPPLIERS TAB
// ═══════════════════════════════════════════════════════

function SuppliersTab() {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState(EMPTY_SUPPLIER_FORM);

  const queryClient = useQueryClient();

  // Shared with the Batches tab's supplier dropdown.
  const { data: suppliers = [], isLoading: loading } = useSuppliers<Supplier>();

  const fetchSuppliers = () =>
    queryClient.invalidateQueries({ queryKey: ["suppliers"] });

  const openAdd = () => {
    setEditing(null);
    setForm(EMPTY_SUPPLIER_FORM);
    setShowForm(true);
  };

  const openEdit = (s: Supplier) => {
    setEditing(s);
    setForm(supplierFormFrom(s));
    setShowForm(true);
  };

  const handleDelete = async (s: Supplier) => {
    if (!confirm(`Delete ${s.name}?`)) return;
    try {
      await api.delete(`/api/suppliers/${s.id}`);
      toast.success("Supplier deleted");
      fetchSuppliers();
    } catch (err) {
      // The server's own sentence, not a guess. A supplier that still has
      // batches against it comes back as a 409 saying exactly that, and a
      // non-admin as a 403 — two different problems the operator would
      // otherwise see as one vague failure.
      const e = err as { response?: { data?: { message?: string } } };
      toast.error(e.response?.data?.message || "Failed to delete the supplier");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (
      form.creditLimit.trim() !== "" &&
      !Number.isFinite(Number(form.creditLimit))
    ) {
      toast.error("Credit limit must be a number");
      return;
    }

    setSubmitting(true);
    try {
      if (editing) {
        await api.put(`/api/suppliers/${editing.id}`, supplierPayload(form));
        toast.success("Supplier updated!");
      } else {
        await api.post("/api/suppliers", supplierPayload(form));
        toast.success("Supplier added!");
      }
      setShowForm(false);
      fetchSuppliers();
    } catch {
      toast.error("Failed to save supplier");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Badge className="bg-slate-700 text-slate-300">
          {suppliers.length} suppliers
        </Badge>
        <Button
          onClick={openAdd}
          className="bg-teal-600 hover:bg-teal-500 text-black h-9"
        >
          <Plus className="w-4 h-4 mr-1" /> Add Supplier
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {loading ? (
          <div className="col-span-3 flex items-center justify-center py-16 text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
          </div>
        ) : suppliers.length === 0 ? (
          <div className="col-span-3 flex flex-col items-center justify-center py-16 text-slate-500">
            <Truck className="w-10 h-10 mb-2 opacity-20" />
            <p>No suppliers yet</p>
          </div>
        ) : (
          suppliers.map((s) => (
            <Card
              key={s.id}
              className="bg-slate-800 border-slate-700 hover:border-slate-600 transition-colors"
            >
              <CardContent className="pt-4 pb-3">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-teal-900/50 flex items-center justify-center">
                      <Truck className="w-4 h-4 text-teal-400" />
                    </div>
                    <div>
                      <p className="text-white font-medium text-sm">{s.name}</p>
                      {s.contactName && (
                        // `text-slate-400`, matching the Suppliers page and
                        // the contact lines below it. At -500 this was the
                        // hint level — one step dimmer than the phone number
                        // under it, for no reason but that the two cards were
                        // written at different times.
                        <p className="text-slate-400 text-xs">
                          {s.contactName}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => openEdit(s)}
                      aria-label={`Edit ${s.name}`}
                      className="p-1.5 rounded-md text-slate-400 hover:text-teal-400 hover:bg-slate-700 transition-colors"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(s)}
                      aria-label={`Delete ${s.name}`}
                      className="p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="space-y-1 text-xs text-slate-400">
                  {s.phone && <p>📞 {s.phone}</p>}
                  {s.email && <p>✉ {s.email}</p>}
                  {s.gstNumber && <p>🏛 GST: {s.gstNumber}</p>}
                  {s.address && <p>📍 {s.address}</p>}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Supplier Form Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Supplier" : "Add Supplier"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3 mt-2">
            <Field label="Supplier Name *">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                placeholder="Supplier name"
                className={inputCls}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Contact Person">
                <Input
                  value={form.contactName}
                  onChange={(e) =>
                    setForm({ ...form, contactName: e.target.value })
                  }
                  placeholder="Contact name"
                  className={inputCls}
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="Phone number"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Email">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="email@example.com"
                  className={inputCls}
                />
              </Field>
              <Field label="GST Number">
                <Input
                  value={form.gstNumber}
                  onChange={(e) =>
                    setForm({ ...form, gstNumber: e.target.value })
                  }
                  placeholder="GSTIN"
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label="Address">
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="Street / shop number"
                className={inputCls}
              />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="City">
                <Input
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  placeholder="Patna"
                  className={inputCls}
                />
              </Field>
              <Field label="State">
                <Input
                  value={form.state}
                  onChange={(e) => setForm({ ...form, state: e.target.value })}
                  placeholder="Bihar"
                  className={inputCls}
                />
              </Field>
              <Field label="PIN Code">
                <Input
                  value={form.pincode}
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(e) => setForm({ ...form, pincode: e.target.value })}
                  placeholder="800004"
                  className={inputCls}
                />
              </Field>
            </div>
            <Separator className="bg-slate-700" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Supplier Code">
                <Input
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="SUP-001"
                  className={inputCls}
                />
              </Field>
              <Field label="Drug Licence No.">
                <Input
                  value={form.drugLicenceNo}
                  onChange={(e) =>
                    setForm({ ...form, drugLicenceNo: e.target.value })
                  }
                  placeholder="BR/PAT/20B-2214"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Payment Terms">
                <Input
                  value={form.paymentTerms}
                  onChange={(e) =>
                    setForm({ ...form, paymentTerms: e.target.value })
                  }
                  placeholder="30 days credit"
                  className={inputCls}
                />
              </Field>
              <Field label="Delivery Days">
                <Input
                  value={form.deliveryDays}
                  onChange={(e) =>
                    setForm({ ...form, deliveryDays: e.target.value })
                  }
                  placeholder="Mon, Wed, Fri"
                  className={inputCls}
                />
              </Field>
              <Field label="Credit Limit (₹)">
                <Input
                  value={form.creditLimit}
                  inputMode="decimal"
                  onChange={(e) =>
                    setForm({ ...form, creditLimit: e.target.value })
                  }
                  placeholder="250000"
                  className={inputCls}
                />
              </Field>
            </div>
            <Field label="Notes">
              <Input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="What they carry, how they deliver"
                className={inputCls}
              />
            </Field>
            <Separator className="bg-slate-700" />
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowForm(false)}
                className="border-slate-600 text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-teal-600 hover:bg-teal-500 text-black"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
                {editing ? "Update" : "Add Supplier"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// MAIN INVENTORY PAGE
// ═══════════════════════════════════════════════════════

const INVENTORY_TABS: TabItem[] = [
  { value: "medicines", label: "Medicines", icon: Package },
  { value: "batches", label: "Stock Batches", icon: Layers },
  { value: "categories", label: "Categories", icon: FlaskConical },
  { value: "suppliers", label: "Suppliers", icon: Truck },
];

export default function Inventory() {
  const [tab, setTab] = useState("medicines");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-white">Inventory Management</h2>
        <p className="text-slate-400 mt-1 text-sm">
          Manage medicines, stock batches, categories and suppliers
        </p>
      </div>

      <Separator className="bg-slate-800" />

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabSwitcher tabs={INVENTORY_TABS} value={tab} onValueChange={setTab} />

        <TabsContent value="medicines">
          <MedicinesTab />
        </TabsContent>
        <TabsContent value="batches">
          <BatchesTab />
        </TabsContent>
        <TabsContent value="categories">
          <CategoriesTab />
        </TabsContent>
        <TabsContent value="suppliers">
          <SuppliersTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
