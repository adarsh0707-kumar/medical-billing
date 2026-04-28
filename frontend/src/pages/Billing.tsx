import api from "@/lib/api";
import { toast } from "sonner";
import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Search,
  Plus,
  Trash2,
  Printer,
  UserPlus,
  Receipt,
  Loader2,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

// ─── Types ─────────────────────────────────────────────

interface MedicineResult {
  id: string;
  name: string;
  genericName: string;
  unit: string;
  gstPercent: number;
  isScheduledH: boolean;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  sellingPrice: number;
  stock: number;
}

interface CartItem {
  batchId: string;
  medicineId: string;
  medicineName: string;
  batchNumber: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  gstPercent: number;
  stock: number;
  expiryDate: string;
}

interface Customer {
  id: string;
  name: string;
  phone?: string;
  age?: number;
  gender?: "MALE" | "FEMALE" | "OTHER";
  address?: string;
}

// ─── Helpers ───────────────────────────────────────────

const calcItemTotal = (item: CartItem) => {
  const subtotal = item.unitPrice * item.quantity;
  const discountVal = (subtotal * item.discount) / 100;
  const taxable = subtotal - discountVal;
  const gst = (taxable * item.gstPercent) / 100;
  return { subtotal, discountVal, taxable, gst, total: taxable + gst };
};

const formatINR = (val: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    val,
  );

// ─── Add Customer Dialog ────────────────────────────────

function AddCustomerDialog({ onAdd }: { onAdd: (c: Customer) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", address: "" });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post("/api/billing/customers", form);
      onAdd(res.data.data);
      toast.success("Customer added!");
      setOpen(false);
      setForm({ name: "", phone: "", address: "" });
    } catch {
      toast.error("Failed to add customer");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="border-slate-600 text-slate-300 hover:bg-slate-700"
        >
          <UserPlus className="w-4 h-4 mr-1" /> New Customer
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-slate-800 border-slate-700 text-white">
        <DialogHeader>
          <DialogTitle>Add New Customer</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="text-slate-300">Name *</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              placeholder="Customer name"
              className="bg-slate-700 border-slate-600 text-white"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-slate-300">Phone</Label>
            <Input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="Phone number"
              className="bg-slate-700 border-slate-600 text-white"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-slate-300">Address</Label>
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="Address"
              className="bg-slate-700 border-slate-600 text-white"
            />
          </div>
          <Button
            type="submit"
            disabled={loading}
            className="w-full bg-teal-600 hover:bg-teal-500"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Add Customer
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Invoice Print View ─────────────────────────────────

function PrintInvoice({
  invoice,
}: {
  invoice: Record<string, unknown> | null;
}) {
  if (!invoice) return null;
  const inv = invoice as {
    invoiceNumber: string;
    date: string;
    customer?: {
      name: string;
      phone?: string;
      age?: number;
      gender?: string;
      address?: string;
    };
    user: { name: string };
    items: CartItem[];
    subtotal: number;
    discountAmt: number;
    cgst: number;
    sgst: number;
    totalAmount: number;
    paymentMode: string;
  };

  return (
    <div
      id="print-invoice"
      className="hidden print:block text-black p-8 font-mono text-sm"
    >
      <div className="text-center border-b pb-4 mb-4">
        <h1 className="text-xl font-bold">MedBill Pro</h1>
        <p className="text-xs">Medical Store Billing System</p>
        <p className="text-xs">Patna, Bihar | GSTIN: XXXXXXXXXXXX</p>
      </div>

      {/* Header Info */}
      <div className="flex justify-between mb-2 text-xs">
        <div>
          <p>
            <strong>Invoice:</strong> {inv.invoiceNumber}
          </p>
          <p>
            <strong>Date:</strong>{" "}
            {new Date(inv.date).toLocaleDateString("en-IN")}
          </p>
          <p>
            <strong>Cashier:</strong> {inv.user?.name}
          </p>
        </div>
      </div>

      {/* Customer Details - Single Line */}
      {inv.customer && (
        <div className="text-xs mb-4 p-2 bg-gray-50">
          <strong>Customer:</strong> {inv.customer.name}
          {inv.customer.phone && ` | Phone: ${inv.customer.phone}`}
          {inv.customer.age && ` | Age: ${inv.customer.age}y`}
          {inv.customer.gender &&
            ` | Gender: ${inv.customer.gender.charAt(0) + inv.customer.gender.slice(1).toLowerCase()}`}
          {inv.customer.address && ` | Address: ${inv.customer.address}`}
        </div>
      )}

      {/* Items Table */}
      <table className="w-full text-xs mb-4">
        <thead>
          <tr className="border-b border-t">
            <th className="text-left py-1">Medicine</th>
            <th className="text-center">Qty</th>
            <th className="text-right">Price</th>
            <th className="text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {inv.items.map((item, i) => (
            <tr key={i} className="border-b border-dashed">
              <td className="py-1">
                <p>{item.medicineName}</p>
                <p className="text-gray-500">Batch: {item.batchNumber}</p>
              </td>
              <td className="text-center">
                {item.quantity} {item.unit}
              </td>
              <td className="text-right">₹{item.unitPrice}</td>
              <td className="text-right">
                ₹{calcItemTotal(item).total.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-right text-xs space-y-1 border-t pt-2 mb-6">
        <p>Subtotal: {formatINR(inv.subtotal)}</p>
        {inv.discountAmt > 0 && <p>Discount: -{formatINR(inv.discountAmt)}</p>}
        <p>CGST: {formatINR(inv.cgst)}</p>
        <p>SGST: {formatINR(inv.sgst)}</p>
        <p className="font-bold text-base border-t pt-1">
          Total: {formatINR(inv.totalAmount)}
        </p>
        <p>Payment: {inv.paymentMode}</p>
      </div>

      {/* Footer Section */}
      <div className="mt-8">
        <p className="text-center text-xs mb-6 border-t pt-3">
          Thank you for your purchase! Get well soon 💊
        </p>

        {/* Signature Section */}
        <div className="flex justify-between items-end text-xs">
          <div className="w-32">
            <p className="text-center">Customer Sign</p>
            <div className="border-t border-black mt-6 h-12"></div>
          </div>

          <div className="w-32 text-right">
            <p className="text-center">Cashier</p>
            <div className="border-t border-black mt-6 h-12"></div>
            <p className="mt-2">{inv.user?.name}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Billing Page ──────────────────────────────────

export default function Billing() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MedicineResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [paymentMode, setPaymentMode] = useState("CASH");
  const [extraDiscount, setExtraDiscount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [lastInvoice, setLastInvoice] = useState<Record<
    string,
    unknown
  > | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ─── Medicine Search ──────────────────────────────────
  useEffect(() => {
    if (query.length < 2) return;
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .get(`/api/inventory/medicines/search?q=${query}`)
        .then((res) => setResults(res.data.data))
        .catch(() => toast.error("Search failed"))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // ─── Customer Search ──────────────────────────────────
  useEffect(() => {
    if (customerSearch.length < 2) return;
    const timer = setTimeout(() => {
      api
        .get(`/api/billing/customers?search=${customerSearch}`)
        .then((res) => setCustomerResults(res.data.data))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [customerSearch]);

  // ─── Add to Cart ──────────────────────────────────────
  const addToCart = (med: MedicineResult) => {
    if (!med.batchId) {
      toast.error(`${med.name} has no stock available!`);
      return;
    }
    if (med.isScheduledH) {
      toast.warning(
        `${med.name} is a Schedule H drug — prescription required!`,
      );
    }
    const existing = cart.findIndex((i) => i.batchId === med.batchId);
    if (existing !== -1) {
      if (cart[existing].quantity >= med.stock) {
        toast.error("Insufficient stock!");
        return;
      }
      setCart((prev) =>
        prev.map((item, idx) =>
          idx === existing ? { ...item, quantity: item.quantity + 1 } : item,
        ),
      );
    } else {
      setCart((prev) => [
        ...prev,
        {
          batchId: med.batchId,
          medicineId: med.id,
          medicineName: med.name,
          batchNumber: med.batchNumber,
          unit: med.unit,
          quantity: 1,
          unitPrice: med.sellingPrice,
          discount: 0,
          gstPercent: med.gstPercent,
          stock: med.stock,
          expiryDate: med.expiryDate,
        },
      ]);
    }
    setQuery("");
    setResults([]);
    searchRef.current?.focus();
    toast.success(`${med.name} added to cart`);
  };

  const updateQty = (idx: number, qty: number) => {
    if (qty < 1) return;
    if (qty > cart[idx].stock) {
      toast.error("Insufficient stock!");
      return;
    }
    setCart((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, quantity: qty } : item)),
    );
  };

  const updateDiscount = (idx: number, disc: number) => {
    setCart((prev) =>
      prev.map((item, i) =>
        i === idx
          ? { ...item, discount: Math.min(100, Math.max(0, disc)) }
          : item,
      ),
    );
  };

  const removeItem = (idx: number) => {
    setCart((prev) => prev.filter((_, i) => i !== idx));
  };

  // ─── Totals ───────────────────────────────────────────
  const subtotal = cart.reduce(
    (sum, item) => sum + calcItemTotal(item).taxable,
    0,
  );
  const totalGst = cart.reduce((sum, item) => sum + calcItemTotal(item).gst, 0);
  const grandTotal = subtotal + totalGst - extraDiscount;

  // ─── Submit Invoice ───────────────────────────────────
  const handleSubmit = async () => {
    if (cart.length === 0) {
      toast.error("Cart is empty!");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        customerId: customer?.id,
        paymentMode,
        paymentStatus: "PAID",
        discountAmt: extraDiscount,
        items: cart.map((item) => ({
          batchId: item.batchId,
          medicineId: item.medicineId,
          medicineName: item.medicineName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount,
          gstPercent: item.gstPercent,
        })),
      };
      const res = await api.post("/api/billing/invoices", payload);
      setLastInvoice(res.data.data);
      toast.success(`Invoice ${res.data.data.invoiceNumber} created!`);
      setCart([]);
      setCustomer(null);
      setExtraDiscount(0);
      setPaymentMode("CASH");
      setTimeout(() => window.print(), 500);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error.response?.data?.message || "Failed to create invoice");
    } finally {
      setSubmitting(false);
    }
  };

  const isExpiringSoon = (date: string) => {
    if (!date) return false;
    const diff =
      (new Date(date).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return diff <= 30;
  };

  // ─── Render ───────────────────────────────────────────
  return (
    <div className="flex gap-4 h-[calc(130vh-112px)]">
      <PrintInvoice invoice={lastInvoice} />

      {/* ── Left: Search + Cart ── */}
      <div className="flex-1 flex flex-col gap-4 min-w-0">
        {/* Medicine Search */}
        <Card className="bg-slate-800 border-slate-700">
          <CardContent className="pt-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              {searching && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 animate-spin" />
              )}
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (e.target.value.length < 2) {
                    setResults([]);
                    setSearching(false);
                  }
                }}
                placeholder="Search medicine by name... (type 2+ chars)"
                className="pl-9 bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500 h-11"
                autoFocus
              />
            </div>

            {/* Results Dropdown */}
            {results.length > 0 && (
              <div className="mt-2 rounded-lg border border-slate-600 overflow-hidden divide-y divide-slate-700">
                {results.map((med) => (
                  <button
                    key={med.id}
                    onClick={() => addToCart(med)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-700 transition-colors text-left"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-white font-medium text-sm">
                          {med.name}
                        </p>
                        {med.isScheduledH && (
                          <Badge
                            variant="destructive"
                            className="text-xs px-1.5 py-0"
                          >
                            Sch-H
                          </Badge>
                        )}
                        {med.expiryDate && isExpiringSoon(med.expiryDate) && (
                          <Badge className="text-xs px-1.5 py-0 bg-yellow-600">
                            Expiring Soon
                          </Badge>
                        )}
                        {!med.batchId && (
                          <Badge className="text-xs px-1.5 py-0 bg-slate-600 text-slate-400">
                            No Stock
                          </Badge>
                        )}
                      </div>
                      <p className="text-slate-400 text-xs mt-0.5">
                        {med.genericName}
                        {med.batchNumber && ` • Batch: ${med.batchNumber}`}
                        {med.expiryDate &&
                          ` • Exp: ${new Date(med.expiryDate).toLocaleDateString("en-IN")}`}
                      </p>
                    </div>
                    <div className="text-right shrink-0 ml-4">
                      <p className="text-teal-400 font-bold">
                        {med.sellingPrice ? `₹${med.sellingPrice}` : "—"}
                      </p>
                      <p className="text-slate-500 text-xs">
                        Stock: {med.stock} {med.unit}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cart */}
        <Card className="bg-slate-800 border-slate-700 flex-1 overflow-hidden flex flex-col">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <div className="flex items-center justify-between">
              <CardTitle className="text-white text-sm font-medium flex items-center gap-2">
                <Receipt className="w-4 h-4 text-teal-400" />
                Cart
                {cart.length > 0 && (
                  <Badge className="bg-teal-600 text-white text-xs">
                    {cart.length}
                  </Badge>
                )}
              </CardTitle>
              {cart.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCart([])}
                  className="text-red-400 hover:text-red-300 hover:bg-red-900/20 text-xs h-7"
                >
                  Clear All
                </Button>
              )}
            </div>
          </CardHeader>

          <CardContent className="flex-1 overflow-y-auto p-0">
            {cart.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-600 py-16">
                <Receipt className="w-12 h-12 mb-3 opacity-20" />
                <p className="text-sm">Search and add medicines to cart</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700/50">
                {cart.map((item, idx) => {
                  const { total } = calcItemTotal(item);
                  return (
                    <div key={`${item.batchId}-${idx}`} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-white text-sm font-medium truncate">
                            {item.medicineName}
                          </p>
                          <p className="text-slate-500 text-xs mt-0.5">
                            Batch: {item.batchNumber} • GST: {item.gstPercent}%
                            {item.expiryDate &&
                              isExpiringSoon(item.expiryDate) && (
                                <span className="text-yellow-500 ml-1">
                                  ⚠ Expiring soon
                                </span>
                              )}
                          </p>
                        </div>
                        <button
                          aria-label="Remove item"
                          onClick={() => removeItem(idx)}
                          className="text-slate-600 hover:text-red-400 transition-colors shrink-0 mt-0.5"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="flex items-center gap-3 mt-2">
                        {/* Quantity */}
                        <div className="flex items-center gap-1">
                          <button
                            aria-label="Decrease quantity"
                            onClick={() => updateQty(idx, item.quantity - 1)}
                            className="w-7 h-7 rounded-md bg-slate-700 text-white hover:bg-slate-600 flex items-center justify-center text-sm font-bold"
                          >
                            −
                          </button>
                          <input
                            type="number"
                            value={item.quantity}
                            onChange={(e) =>
                              updateQty(idx, Number(e.target.value))
                            }
                            className="w-12 h-7 text-center bg-slate-700 border border-slate-600 rounded-md text-white text-sm"
                          />
                          <button
                            aria-label="Increase quantity"
                            onClick={() => updateQty(idx, item.quantity + 1)}
                            className="w-7 h-7 rounded-md bg-slate-700 text-white hover:bg-slate-600 flex items-center justify-center text-sm font-bold"
                          >
                            +
                          </button>
                        </div>

                        {/* Price */}
                        <div className="flex items-center gap-1">
                          <span className="text-slate-500 text-xs">₹</span>
                          <input
                            type="number"
                            value={item.unitPrice}
                            onChange={(e) =>
                              setCart((prev) =>
                                prev.map((it, i) =>
                                  i === idx
                                    ? {
                                        ...it,
                                        unitPrice: Number(e.target.value),
                                      }
                                    : it,
                                ),
                              )
                            }
                            className="w-20 h-7 text-center bg-slate-700 border border-slate-600 rounded-md text-white text-sm"
                          />
                        </div>

                        {/* Discount */}
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            value={item.discount}
                            onChange={(e) =>
                              updateDiscount(idx, Number(e.target.value))
                            }
                            className="w-14 h-7 text-center bg-slate-700 border border-slate-600 rounded-md text-white text-sm"
                          />
                          <span className="text-slate-500 text-xs">%off</span>
                        </div>

                        <p className="ml-auto text-teal-400 font-bold text-sm">
                          {formatINR(total)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Right: Customer + Summary ── */}
      <div className="w-80 flex flex-col gap-4 shrink-0">
        {/* Customer */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <CardTitle className="text-white text-sm font-medium">
              Customer
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 space-y-2">
            {customer ? (
              <div className="flex items-start justify-between gap-3 p-3 bg-teal-900/30 rounded-lg border border-teal-800">
                <div className="flex-1">
                  <p className="text-white text-sm font-medium">
                    {customer.name}
                  </p>
                  {customer.phone && (
                    <p className="text-slate-400 text-xs">{customer.phone}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    {customer.age && (
                      <span className="text-slate-400 text-xs">
                        Age: {customer.age}y
                      </span>
                    )}
                    {customer.gender && (
                      <span className="text-slate-400 text-xs">
                        {customer.gender.charAt(0) +
                          customer.gender.slice(1).toLowerCase()}
                      </span>
                    )}
                  </div>
                  {customer.address && (
                    <p className="text-slate-400 text-xs mt-1">
                      {customer.address}
                    </p>
                  )}
                </div>
                <button
                  aria-label="Remove customer"
                  onClick={() => setCustomer(null)}
                  className="text-slate-500 hover:text-red-400 shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                  <Input
                    value={customerSearch}
                    onChange={(e) => {
                      setCustomerSearch(e.target.value);
                      if (e.target.value.length < 2) setCustomerResults([]);
                    }}
                    placeholder="Search customer..."
                    className="pl-8 h-9 bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 text-sm"
                  />
                </div>
                {customerResults.length > 0 && (
                  <div className="rounded-lg border border-slate-600 overflow-hidden divide-y divide-slate-700">
                    {customerResults.slice(0, 4).map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          setCustomer(c);
                          setCustomerSearch("");
                          setCustomerResults([]);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-slate-700 transition-colors"
                      >
                        <p className="text-white text-sm">{c.name}</p>
                        <div className="flex items-center gap-2">
                          {c.phone && (
                            <p className="text-slate-400 text-xs">{c.phone}</p>
                          )}
                          {c.age && (
                            <p className="text-slate-400 text-xs">{c.age}y</p>
                          )}
                          {c.gender && (
                            <p className="text-slate-400 text-xs">
                              {c.gender.charAt(0) +
                                c.gender.slice(1).toLowerCase()}
                            </p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <AddCustomerDialog onAdd={setCustomer} />
              </>
            )}
          </CardContent>
        </Card>

        {/* Bill Summary */}
        <Card className="bg-slate-800 border-slate-700 flex-1">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <CardTitle className="text-white text-sm font-medium">
              Bill Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-slate-400">
                <span>Subtotal</span>
                <span>{formatINR(subtotal)}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>GST</span>
                <span>{formatINR(totalGst)}</span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Extra Discount</span>
                <div className="flex items-center gap-1">
                  <span>₹</span>
                  <input
                    type="number"
                    value={extraDiscount}
                    onChange={(e) =>
                      setExtraDiscount(Math.max(0, Number(e.target.value)))
                    }
                    className="w-20 h-7 text-right bg-slate-700 border border-slate-600 rounded text-white text-sm px-2"
                  />
                </div>
              </div>
            </div>

            <Separator className="bg-slate-700" />

            <div className="flex justify-between items-center">
              <span className="text-white font-bold">Total</span>
              <span className="text-teal-400 font-bold text-xl">
                {formatINR(grandTotal)}
              </span>
            </div>

            {/* GST Breakdown */}
            <div className="bg-slate-700/50 rounded-lg p-3 text-xs space-y-1 text-slate-400">
              <div className="flex justify-between">
                <span>CGST</span>
                <span>{formatINR(totalGst / 2)}</span>
              </div>
              <div className="flex justify-between">
                <span>SGST</span>
                <span>{formatINR(totalGst / 2)}</span>
              </div>
            </div>

            {/* Payment Mode */}
            <div className="space-y-1.5">
              <Label className="text-slate-400 text-xs">Payment Mode</Label>
              <Select value={paymentMode} onValueChange={setPaymentMode}>
                <SelectTrigger className="bg-slate-700 border-slate-600 text-white h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  {["CASH", "UPI", "CARD", "CREDIT"].map((mode) => (
                    <SelectItem
                      key={mode}
                      value={mode}
                      className="text-white hover:bg-slate-700 focus:bg-slate-700"
                    >
                      {mode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Actions */}
            <div className="space-y-2 pt-2">
              <Button
                onClick={handleSubmit}
                disabled={submitting || cart.length === 0}
                className="w-full bg-teal-600 hover:bg-teal-500 text-white font-bold h-11"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />{" "}
                    Processing...
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" /> Generate Invoice
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => lastInvoice && window.print()}
                disabled={!lastInvoice}
                className="w-full border-slate-600 text-slate-300 hover:bg-slate-700 h-9"
              >
                <Printer className="w-4 h-4 mr-2" /> Print Last Invoice
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
