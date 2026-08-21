import { useState, useEffect, useCallback } from "react";
import {
  Users,
  Plus,
  Search,
  Eye,
  Phone,
  Mail,
  MapPin,
  Receipt,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Edit2,
} from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

interface Invoice {
  id: string;
  invoiceNumber: string;
  date: string;
  totalAmount: number;
  paymentMode: string;
  paymentStatus: string;
}

// Update interface
interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  age?: number;
  gender?: "MALE" | "FEMALE" | "OTHER";
  createdAt: string;
  _count?: { invoices: number };
  invoices?: Invoice[];
}

// ─── Helpers ───────────────────────────────────────────

const formatINR = (v: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    v,
  );

const GENDER_ICON: Record<string, string> = {
  MALE: "♂",
  FEMALE: "♀",
  OTHER: "⚧",
};
const inputCls =
  "bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500 h-9";

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

// ─── Customer Detail Dialog ─────────────────────────────

function CustomerDetailDialog({
  customerId,
  open,
  onClose,
}: {
  customerId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!customerId || !open) return;
    setLoading(true);
    api
      .get(`/api/billing/customers/${customerId}`)
      .then((r) => setCustomer(r.data.data))
      .catch(() => toast.error("Failed to load customer"))
      .finally(() => setLoading(false));
  }, [customerId, open]);

  const totalSpent =
    customer?.invoices?.reduce((s, i) => s + i.totalAmount, 0) || 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-lg">
        <DialogHeader>
          <DialogTitle>Customer Profile</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-teal-400" />
          </div>
        ) : customer ? (
          <div className="space-y-4">
            {/* Profile */}
            <div className="flex items-center gap-4 p-4 bg-slate-700/50 rounded-xl">
              <div className="w-14 h-14 rounded-full bg-teal-600 flex items-center justify-center text-white text-2xl font-bold">
                {customer.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <h3 className="text-white text-lg font-bold">
                  {customer.name}
                </h3>
                <div className="flex items-center gap-3 mt-1">
                  {customer.age && (
                    <span className="text-slate-400 text-sm">
                      Age: {customer.age} yrs
                    </span>
                  )}
                  {customer.gender && (
                    <Badge
                      className={`text-xs ${
                        customer.gender === "MALE"
                          ? "bg-blue-900/50 text-blue-400"
                          : customer.gender === "FEMALE"
                            ? "bg-pink-900/50 text-pink-400"
                            : "bg-purple-900/50 text-purple-400"
                      }`}
                    >
                      {GENDER_ICON[customer.gender]}{" "}
                      {customer.gender.charAt(0) +
                        customer.gender.slice(1).toLowerCase()}
                    </Badge>
                  )}
                </div>
                <p className="text-slate-400 text-sm">
                  Member since{" "}
                  {new Date(customer.createdAt).toLocaleDateString("en-IN", {
                    month: "long",
                    year: "numeric",
                  })}
                </p>
              </div>
            </div>

            {/* Contact Info */}
            <div className="grid grid-cols-2 gap-3">
              {customer.phone && (
                <div className="flex items-center gap-2 text-slate-300 text-sm">
                  <Phone className="w-4 h-4 text-slate-500" />
                  {customer.phone}
                </div>
              )}
              {customer.email && (
                <div className="flex items-center gap-2 text-slate-300 text-sm">
                  <Mail className="w-4 h-4 text-slate-500" />
                  {customer.email}
                </div>
              )}
              {customer.address && (
                <div className="flex items-center gap-2 text-slate-300 text-sm col-span-2">
                  <MapPin className="w-4 h-4 text-slate-500 shrink-0" />
                  {customer.address}
                </div>
              )}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-700/50 rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-teal-400">
                  {customer._count?.invoices || 0}
                </p>
                <p className="text-slate-400 text-xs mt-1">Total Invoices</p>
              </div>
              <div className="bg-slate-700/50 rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-teal-400">
                  {formatINR(totalSpent)}
                </p>
                <p className="text-slate-400 text-xs mt-1">Total Spent</p>
              </div>
            </div>

            {/* Recent Invoices */}
            {customer.invoices && customer.invoices.length > 0 && (
              <div>
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                  Recent Purchases
                </p>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {customer.invoices.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between px-3 py-2 bg-slate-700/50 rounded-lg"
                    >
                      <div>
                        <p className="text-white text-sm font-mono">
                          {inv.invoiceNumber}
                        </p>
                        <p className="text-slate-500 text-xs">
                          {new Date(inv.date).toLocaleDateString("en-IN")}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-teal-400 font-bold text-sm">
                          {formatINR(inv.totalAmount)}
                        </p>
                        <Badge
                          className={`text-xs px-1.5 py-0 ${
                            inv.paymentMode === "CASH"
                              ? "bg-green-900/50 text-green-400"
                              : inv.paymentMode === "UPI"
                                ? "bg-blue-900/50 text-blue-400"
                                : "bg-slate-700 text-slate-300"
                          }`}
                        >
                          {inv.paymentMode}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Customers Page ────────────────────────────────

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    address: "",
    age: "",
    gender: "",
  });

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: "12",
        ...(search && { search }),
      });
      const res = await api.get(`/api/billing/customers?${params}`);
      setCustomers(res.data.data);
      setTotalPages(res.data.pagination.pages);
      setTotal(res.data.pagination.total);
    } catch {
      toast.error("Failed to fetch customers");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const openAdd = () => {
    setEditing(null);
    setForm({
      name: "",
      phone: "",
      email: "",
      address: "",
      age: "",
      gender: "",
    });
    setShowForm(true);
  };

  const openEdit = (c: Customer) => {
    setEditing(c);
    setForm({
      name: c.name,
      phone: c.phone || "",
      email: c.email || "",
      address: c.address || "",
      age: c.age ? String(c.age) : "",
      gender: c.gender || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      // Prepare data, only include age and gender if they have values
      const data = {
        name: form.name,
        phone: form.phone,
        email: form.email,
        address: form.address,
        ...(form.age && { age: Number(form.age) }),
        ...(form.gender && { gender: form.gender }),
      };

      if (editing) {
        await api.put(`/api/billing/customers/${editing.id}`, data);
        toast.success("Customer updated!");
      } else {
        await api.post("/api/billing/customers", data);
        toast.success("Customer added!");
      }
      setShowForm(false);
      fetchCustomers();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      toast.error(e.response?.data?.message || "Failed to save");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Customers</h2>
          <p className="text-slate-400 mt-1 text-sm">
            Manage customer profiles and purchase history
          </p>
        </div>
        <Button
          onClick={openAdd}
          className="bg-teal-600 hover:bg-teal-500 text-white"
        >
          <Plus className="w-4 h-4 mr-1" /> Add Customer
        </Button>
      </div>

      <Separator className="bg-slate-800" />

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name or phone..."
            className={`pl-9 ${inputCls}`}
          />
        </div>
        <Badge className="bg-slate-700 text-slate-300">{total} customers</Badge>
      </div>

      {/* Customers Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading customers...
        </div>
      ) : customers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-600">
          <Users className="w-12 h-12 mb-3 opacity-20" />
          <p>No customers found</p>
          <Button
            onClick={openAdd}
            size="sm"
            className="mt-3 bg-teal-600 hover:bg-teal-500 text-white"
          >
            Add First Customer
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {customers.map((c) => (
            <Card
              key={c.id}
              className="bg-slate-800 border-slate-700 hover:border-slate-600 transition-all group"
            >
              <CardContent className="pt-4 pb-3">
                {/* Avatar + Name */}
                <div className="flex items-start gap-3 mb-3">
                  <div
                    className="w-10 h-10 rounded-full bg-gradient-to-br from-teal-600 to-teal-800
                    flex items-center justify-center text-white font-bold text-lg shrink-0"
                  >
                    {c.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium text-sm truncate">
                      {c.name}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {c.age && (
                        <span className="text-slate-500 text-xs">{c.age}y</span>
                      )}
                      {c.gender && (
                        <span
                          className={`text-xs font-medium ${
                            c.gender === "MALE"
                              ? "text-blue-400"
                              : c.gender === "FEMALE"
                                ? "text-pink-400"
                                : "text-purple-400"
                          }`}
                        >
                          {GENDER_ICON[c.gender]}{" "}
                          {c.gender.charAt(0) + c.gender.slice(1).toLowerCase()}
                        </span>
                      )}
                    </div>
                    {c.phone && (
                      <p className="text-slate-400 text-xs flex items-center gap-1 mt-0.5">
                        <Phone className="w-3 h-3" /> {c.phone}
                      </p>
                    )}
                    {c.email && (
                      <p className="text-slate-500 text-xs truncate">
                        {c.email}
                      </p>
                    )}
                  </div>
                </div>

                {/* Stats */}
                <div className="flex items-center justify-between pt-2 border-t border-slate-700">
                  <div className="flex items-center gap-1 text-slate-400 text-xs">
                    <Receipt className="w-3.5 h-3.5" />
                    {c._count?.invoices || 0} bills
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      aria-label="Edit customer"
                      onClick={() => openEdit(c)}
                      className="p-1.5 rounded-md text-slate-400 hover:text-teal-400 hover:bg-slate-700 transition-colors"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      aria-label="View customer details"
                      onClick={() => setDetailId(c.id)}
                      className="p-1.5 rounded-md text-slate-400 hover:text-blue-400 hover:bg-slate-700 transition-colors"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p - 1)}
            disabled={page === 1}
            className="border-slate-600 text-slate-300 hover:bg-slate-700 h-8 w-8 p-0"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-slate-400 text-sm">
            Page {page} of {totalPages}
          </span>
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
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Customer" : "Add New Customer"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3 mt-2">
            <Field label="Full Name *">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                placeholder="Customer name"
                className={inputCls}
              />
            </Field>

            {/* Age + Gender row */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Age">
                <Input
                  type="number"
                  min="0"
                  max="120"
                  value={form.age}
                  onChange={(e) => setForm({ ...form, age: e.target.value })}
                  placeholder="Years"
                  className={inputCls}
                />
              </Field>
              <Field label="Gender">
                <Select
                  value={form.gender}
                  onValueChange={(v) => setForm({ ...form, gender: v })}
                >
                  <SelectTrigger className="bg-slate-700 border-slate-600 text-white h-9">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    <SelectItem
                      value="MALE"
                      className="text-white focus:bg-slate-700"
                    >
                      Male
                    </SelectItem>
                    <SelectItem
                      value="FEMALE"
                      className="text-white focus:bg-slate-700"
                    >
                      Female
                    </SelectItem>
                    <SelectItem
                      value="OTHER"
                      className="text-white focus:bg-slate-700"
                    >
                      Other
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {/* Phone + Email row */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone">
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="Mobile number"
                  className={inputCls}
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="Email"
                  className={inputCls}
                />
              </Field>
            </div>

            <Field label="Address">
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="Full address"
                className={inputCls}
              />
            </Field>
            <Separator className="bg-slate-700" />
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowForm(false)}
                className="border-slate-600 text-slate-500 hover:bg-slate-700"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-teal-600 hover:bg-teal-500 text-white"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
                {editing ? "Update" : "Add Customer"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <CustomerDetailDialog
        customerId={detailId}
        open={!!detailId}
        onClose={() => setDetailId(null)}
      />
    </div>
  );
}
