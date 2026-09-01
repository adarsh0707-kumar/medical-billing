import api from "@/lib/api";
import { amountInWords } from "@/lib/amount-in-words";
import { printAs } from "@/lib/print-document";
import type { CreateInvoiceInput } from "@/types/api.generated";
import { useQuery } from "@tanstack/react-query";
import { calcItemTotal, calcCartTotals } from "@/lib/cart-math";
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
  Layers,
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

// One sellable batch of a medicine. The POS needs price and expiry per batch
// because both vary between them (AD-03).
interface BatchOption {
  id: string;
  batchNumber: string;
  expiryDate: string;
  sellingPrice: number;
  quantity: number;
}

interface MedicineResult {
  id: string;
  name: string;
  genericName: string;
  unit: string;
  gstPercent: number;
  isScheduledH: boolean;
  // The FEFO default, flattened. Identical to `batches[0]`, kept flat because
  // the overwhelmingly common action is "take what FEFO picked".
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  sellingPrice: number;
  stock: number;
  // Every batch the operator may choose instead, earliest expiry first.
  batches: BatchOption[];
  // In-stock batches that are past their date, so the row can say "expired"
  // rather than "no stock" over a shelf that is actually full.
  expiredBatches: number;
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
  // Carried so the cart itself knows when the register entry is due, rather
  // than re-querying the medicine at submit time.
  isScheduledH: boolean;
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

// Cart arithmetic lives in lib/cart-math so it can be unit-tested against the
// server's fixtures — see docs/09 section 4. It runs in integer paise and mirrors
// the Decimal pipeline in backend/src/controllers/billing.controller.js.

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
      const res = await api.post("/api/customers", form);
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
              className="bg-slate-700 border-slate-600 text-slate-100"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-slate-300">Phone</Label>
            <Input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="Phone number"
              className="bg-slate-700 border-slate-600 text-slate-100"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-slate-300">Address</Label>
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="Address"
              className="bg-slate-700 border-slate-600 text-slate-100"
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

interface ShopInfo {
  name: string;
  address?: string | null;
  phone?: string | null;
  gstNumber?: string | null;
  drugLicenceNo?: string | null;
}

/** One printed line, as the API returns it — not the cart's shape. */
interface PrintedItem {
  medicineName: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  gstPercent: number;
  totalPrice: number;
  batch?: {
    batchNumber: string;
    expiryDate: string;
    mrp?: number | null;
    medicine?: {
      hsnCode?: string | null;
      unit?: string | null;
      packSize?: string | null;
    } | null;
  } | null;
}

/** `MM/YY`, the way an expiry is printed on a pharmacy invoice. */
const expShort = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getFullYear()).slice(2)}`;
};

/** Bare 2 dp — the money columns are a table, so the ₹ goes in the header. */
const amt = (n: number) => Number(n ?? 0).toFixed(2);

function PrintInvoice({
  invoice,
  shop,
}: {
  invoice: Record<string, unknown> | null;
  shop?: ShopInfo;
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
    items: PrintedItem[];
    subtotal: number;
    discountAmt: number;
    cgst: number;
    sgst: number;
    totalAmount: number;
    paymentMode: string;
    notes?: string | null;
  };

  // Falls back to the product name if the shop hasn't filled in its own yet —
  // a brand-new shop that hasn't visited Settings still gets a printable
  // invoice, just without its own details on it.
  const shopName = shop?.name || "MedBill Pro";
  // Address, phone and GSTIN are rendered as their own lines in the seller box
  // below, each guarded individually, so a shop that has filled in only some of
  // them never prints a stray separator or the word "undefined".

  // Both halves of the tax, rounded and equal by construction — printed as the
  // rate rather than as a bare figure, because that is what a GST return is
  // reconciled against.
  const halfRate = inv.items.length
    ? Number(inv.items[0].gstPercent ?? 0) / 2
    : 0;
  const mixedRates =
    new Set(inv.items.map((i) => Number(i.gstPercent ?? 0))).size > 1;

  return (
    <div
      id="print-invoice"
      className="hidden print:block text-black p-6 font-sans text-[11px] leading-tight"
    >
      {/* ── Parties. Seller left, buyer right, the way a tax invoice is read. */}
      <div className="border border-black">
        <div className="grid grid-cols-2">
          <div className="p-2 border-r border-black">
            <p className="font-bold text-sm uppercase">{shopName}</p>
            {shop?.address && <p>{shop.address}</p>}
            {shop?.phone && <p>Phone : {shop.phone}</p>}
            {shop?.gstNumber && <p>GSTIN : {shop.gstNumber}</p>}
            {shop?.drugLicenceNo && <p>D.L. No. : {shop.drugLicenceNo}</p>}
          </div>
          <div className="p-2">
            <p>
              <span className="font-semibold">M/S : </span>
              {inv.customer?.name ?? "Walk-in Customer"}
            </p>
            {inv.customer?.address && <p>ADD. : {inv.customer.address}</p>}
            {inv.customer?.phone && <p>MOB. : {inv.customer.phone}</p>}
          </div>
        </div>

        <div className="grid grid-cols-2 border-t border-black">
          <div className="p-1 px-2 border-r border-black text-center">
            <span className="font-bold tracking-wide">GST INVOICE</span>
          </div>
          <div className="p-1 px-2 flex justify-between">
            <span>
              <span className="font-semibold">Invoice No. : </span>
              {inv.invoiceNumber}
            </span>
            <span>
              <span className="font-semibold">Date : </span>
              {new Date(inv.date).toLocaleDateString("en-GB")}
            </span>
          </div>
        </div>

        {/* ── Lines. The column set a distributor's GST invoice carries, minus
             the two this system has no field for — see the note below. */}
        <table className="w-full border-collapse border-t border-black">
          <thead>
            <tr className="border-b border-black">
              {[
                "SN.",
                "PRODUCT NAME",
                "PACK",
                "HSN",
                "BATCH",
                "EXP.",
                "QTY",
                "MRP",
                "RATE",
                "DIS%",
                "GST",
                "N.RATE",
                "AMOUNT",
              ].map((h, i) => (
                <th
                  key={h}
                  className={`px-1 py-0.5 font-semibold border-black ${
                    i === 1 ? "text-left" : "text-right"
                  } ${i ? "border-l" : ""}`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inv.items.map((item, i) => {
              const rate = Number(item.unitPrice ?? 0);
              const disc = Number(item.discount ?? 0);
              // What the line is actually charged at, after its discount —
              // the figure that times quantity gives the taxable value.
              const netRate = rate * (1 - disc / 100);
              return (
                <tr key={i} className="align-top">
                  <td className="px-1 text-right">{i + 1}.</td>
                  <td className="px-1 text-left">
                    {item.medicineName}
                    {item.batch?.medicine?.unit && (
                      <span className="text-[9px]"> ({item.batch.medicine.unit})</span>
                    )}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {item.batch?.medicine?.packSize ?? ""}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {item.batch?.medicine?.hsnCode ?? ""}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {item.batch?.batchNumber ?? ""}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {expShort(item.batch?.expiryDate)}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {item.quantity}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {item.batch?.mrp != null ? amt(item.batch.mrp) : ""}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {amt(rate)}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {disc ? `${amt(disc)}%` : "—"}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {Number(item.gstPercent ?? 0)}%
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {amt(netRate)}
                  </td>
                  <td className="px-1 text-right border-l border-black">
                    {amt(item.totalPrice)}
                  </td>
                </tr>
              );
            })}
            {/* Keeps the box a consistent height on a short bill, so the
                totals block does not ride up under the header. */}
            {Array.from({ length: Math.max(0, 8 - inv.items.length) }).map(
              (_, i) => (
                <tr key={`pad-${i}`}>
                  <td colSpan={13} className="px-1">
                    &nbsp;
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>

        {/* ── Tax summary and totals. */}
        <div className="grid grid-cols-2 border-t border-black">
          <div className="p-2 border-r border-black">
            <p>
              GST : {amt(inv.subtotal)}
              {mixedRates
                ? " @ mixed rates"
                : ` @ ${halfRate}% + ${halfRate}%`}{" "}
              = {amt(inv.sgst)} SGST + {amt(inv.cgst)} CGST
            </p>
            <p className="mt-1">
              <span className="font-semibold">Payment : </span>
              {inv.paymentMode}
            </p>
            <p className="mt-2 font-semibold">{amountInWords(inv.totalAmount)}</p>
          </div>
          <div className="p-2">
            <table className="w-full">
              <tbody>
                <tr>
                  <td>SUB TOTAL</td>
                  <td className="text-right">{amt(inv.subtotal)}</td>
                </tr>
                {inv.discountAmt > 0 && (
                  <tr>
                    <td>Discount</td>
                    <td className="text-right">{amt(inv.discountAmt)}</td>
                  </tr>
                )}
                <tr>
                  <td>SGST{mixedRates ? "" : ` ${halfRate}%`}</td>
                  <td className="text-right">{amt(inv.sgst)}</td>
                </tr>
                <tr>
                  <td>CGST{mixedRates ? "" : ` ${halfRate}%`}</td>
                  <td className="text-right">{amt(inv.cgst)}</td>
                </tr>
                <tr className="border-t border-black font-bold text-sm">
                  <td className="pt-1">GRAND TOTAL</td>
                  <td className="text-right pt-1">{amt(inv.totalAmount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Terms and signature. */}
        <div className="grid grid-cols-2 border-t border-black">
          <div className="p-2 border-r border-black">
            {inv.notes && (
              <p className="mb-1">
                <span className="font-semibold">Remark : </span>
                {inv.notes}
              </p>
            )}
            <p className="font-semibold underline">Terms &amp; Conditions</p>
            <p>Goods once sold will not be taken back or exchanged.</p>
            <p>All disputes subject to local jurisdiction only.</p>
            <p>Medicines dispensed against a valid prescription where required.</p>
          </div>
          <div className="p-2 flex flex-col justify-between">
            <p className="text-right">For {shopName}</p>
            <p className="text-right mt-8">Authorised Signatory</p>
          </div>
        </div>
      </div>

      <p className="mt-1 text-[9px] text-right">
        Billed by {inv.user?.name}
      </p>
    </div>
  );
}

// ─── Main Billing Page ──────────────────────────────────

export default function Billing() {
  // Fetched once and cached — the invoice header needs it at print time, and
  // it changes rarely enough that react-query's default staleness is fine.
  const { data: shop } = useQuery<ShopInfo>({
    queryKey: ["shop"],
    queryFn: async () => (await api.get("/api/shop")).data.data,
  });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MedicineResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  // Narrowed to the contract's four modes rather than `string`. The Select is
  // uncontrolled as far as TypeScript is concerned — it hands back whatever
  // string its items carry — so this is where a fifth mode would have to be
  // added deliberately instead of arriving by typo.
  const [paymentMode, setPaymentMode] =
    useState<NonNullable<CreateInvoiceInput["paymentMode"]>>("CASH");
  const [extraDiscount, setExtraDiscount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // The Schedule H register entry (FR-MED-12). Kept beside the cart because it
  // belongs to the sale, and is cleared with it.
  const emptyRx = {
    prescriberName: "",
    prescriberRegNo: "",
    prescribedOn: new Date().toISOString().slice(0, 10),
    patientName: "",
  };
  const [prescription, setPrescription] = useState(emptyRx);
  const [lastInvoice, setLastInvoice] = useState<Record<
    string,
    unknown
  > | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // The medicine whose batch list is open. Null means FEFO is in charge.
  const [batchPicker, setBatchPicker] = useState<MedicineResult | null>(null);
  // Reading the clock during render is impure. The expiry highlight is a 30-day
  // threshold, which cannot change meaningfully inside one billing session, so a
  // single mount-time reading is enough — and it keeps every badge in a render
  // measured against the same instant.
  const [nowMs] = useState(() => Date.now());

  // ─── Medicine Search ──────────────────────────────────
  useEffect(() => {
    if (query.length < 2) return;
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .get(`/api/medicines/search?q=${query}`)
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
        .get(`/api/customers?search=${customerSearch}`)
        .then((res) => setCustomerResults(res.data.data))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [customerSearch]);

  // ─── Add to Cart ──────────────────────────────────────
  // `chosen` is the deliberate override (FR-BILL-19). Omitting it takes the FEFO
  // batch, which is what every ordinary sale does — the default has to stay a
  // single click, or FEFO stops being the default in practice.
  const addToCart = (med: MedicineResult, chosen?: BatchOption) => {
    const batch: BatchOption | null =
      chosen ??
      (med.batchId
        ? {
            id: med.batchId,
            batchNumber: med.batchNumber,
            expiryDate: med.expiryDate,
            sellingPrice: med.sellingPrice,
            quantity: med.stock,
          }
        : null);

    if (!batch) {
      toast.error(
        med.expiredBatches > 0
          ? `All stock of ${med.name} has expired and cannot be sold. Remove it from the shelf.`
          : `${med.name} has no stock available!`,
      );
      return;
    }
    // The search no longer offers expired batches, so this should be
    // unreachable. It stays because the API refuses the sale outright and no
    // role can override it: a stale result list on a till left open overnight
    // would otherwise build a cart that cannot be sold. The server is still the
    // boundary — this is a courtesy, not the control.
    if (isExpired(batch.expiryDate)) {
      toast.error(
        `${med.name} expired on ${new Date(batch.expiryDate).toLocaleDateString("en-IN")} and cannot be sold. Remove it from stock.`,
      );
      return;
    }
    if (med.isScheduledH) {
      toast.warning(
        `${med.name} is a Schedule H drug — prescription required!`,
      );
    }
    const existing = cart.findIndex((i) => i.batchId === batch.id);
    if (existing !== -1) {
      if (cart[existing].quantity >= batch.quantity) {
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
          batchId: batch.id,
          medicineId: med.id,
          medicineName: med.name,
          batchNumber: batch.batchNumber,
          unit: med.unit,
          quantity: 1,
          unitPrice: batch.sellingPrice,
          discount: 0,
          gstPercent: med.gstPercent,
          stock: batch.quantity,
          expiryDate: batch.expiryDate,
          isScheduledH: med.isScheduledH,
        },
      ]);
    }
    setBatchPicker(null);
    setQuery("");
    setResults([]);
    searchRef.current?.focus();
    toast.success(
      chosen
        ? `${med.name} (batch ${batch.batchNumber}) added to cart`
        : `${med.name} added to cart`,
    );
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
  const { cgstPaise, sgstPaise, subtotal, totalGst, grandTotal } =
    calcCartTotals(cart, extraDiscount);

  // ─── Submit Invoice ───────────────────────────────────
  const handleSubmit = async () => {
    if (cart.length === 0) {
      toast.error("Cart is empty!");
      return;
    }
    // The server refuses a bill discount larger than the bill (F7, docs/09
    // section 4) rather than clamping it. Caught here too so the cashier sees
    // what is wrong at the counter instead of a 400 after pressing the button.
    if (grandTotal < 0) {
      toast.error(
        `Discount is more than the bill. Reduce it to ${formatINR(subtotal + totalGst)} or less.`,
      );
      return;
    }
    // A Schedule H drug may only be supplied against a registered
    // practitioner's prescription, and the particulars have to be recorded
    // (FR-MED-12). The API refuses without them; catching it here means the
    // cashier fills the form instead of losing the cart to a 400.
    if (needsPrescription) {
      const missing = (
        [
          ["prescriber's name", prescription.prescriberName],
          ["registration number", prescription.prescriberRegNo],
          ["prescription date", prescription.prescribedOn],
          ["patient's name", prescription.patientName],
        ] as const
      ).find(([, value]) => !value.trim());
      if (missing) {
        toast.error(`Schedule H sale: the ${missing[0]} is required.`);
        return;
      }
    }
    setSubmitting(true);
    try {
      // Typed against the backend's `createInvoiceSchema` (NFR-22). A field
      // renamed or newly required in the schema now fails `tsc` here rather than
      // coming back as a 400 in front of a customer.
      const payload: CreateInvoiceInput = {
        customerId: customer?.id,
        paymentMode,
        paymentStatus: "PAID",
        discountAmt: extraDiscount,
        ...(needsPrescription && { prescription }),
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
      setPrescription(emptyRx);
      setPaymentMode("CASH");
      // Named after the invoice, so "Save as PDF" produces
      // INV260831-0005.pdf rather than overwriting frontend.pdf each time.
      setTimeout(() => printAs(res.data.data.invoiceNumber), 500);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error.response?.data?.message || "Failed to create invoice");
    } finally {
      setSubmitting(false);
    }
  };

  // Any Schedule H line makes the register entry mandatory for the whole bill:
  // one prescription covers the sale, which is how it works at the counter.
  const needsPrescription = cart.some((item) => item.isScheduledH);

  const isExpiringSoon = (date: string) => {
    if (!date) return false;
    const diff = (new Date(date).getTime() - nowMs) / (1000 * 60 * 60 * 24);
    return diff <= 30;
  };

  // Mirrors the server rule (FR-BATCH-09): a medicine is good *through* the date
  // printed on it, so a batch expiring today still sells and one that expired
  // yesterday does not. Compared against local midnight, exactly as
  // billing.controller.js does — a stricter client would refuse sales the API
  // would happily take, and a looser one would let the cashier build a cart that
  // fails on submit.
  const isExpired = (date: string) => {
    if (!date) return false;
    const startOfToday = new Date(nowMs);
    startOfToday.setHours(0, 0, 0, 0);
    return new Date(date).getTime() < startOfToday.getTime();
  };

  // ─── Render ───────────────────────────────────────────
  return (
    // Stacked below lg — search and cart first, then customer and summary,
    // which is the order a sale is actually made in. Side by side it put a
    // fixed 320px summary column beside the cart, leaving the cart ~24px of a
    // 360px screen; the till was the part you could not see.
    <div className="flex flex-col lg:flex-row gap-4 lg:h-[calc(180vh-112px)]">
      <PrintInvoice invoice={lastInvoice} shop={shop} />

      {/* Batch override (FR-BILL-19). FEFO remains what a plain click does; this
          exists for the two cases FEFO cannot see — the customer needs a
          specific pack, or the earliest-expiring one is physically at the back
          of the shelf. */}
      <Dialog
        open={batchPicker !== null}
        onOpenChange={(open) => !open && setBatchPicker(null)}
      >
        <DialogContent className="bg-slate-800 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>Choose a batch — {batchPicker?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-slate-400 text-xs -mt-2">
            Earliest expiry first. The first is what the till would pick on its
            own; choose another only when you have a reason to.
          </p>
          <div className="rounded-lg border border-slate-600 overflow-hidden divide-y divide-slate-700 max-h-80 overflow-y-auto">
            {batchPicker?.batches.map((b, idx) => (
              <button
                key={b.id}
                onClick={() => addToCart(batchPicker, b)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-700 transition-colors text-left"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-white text-sm font-medium">
                      {b.batchNumber}
                    </p>
                    {idx === 0 && (
                      <Badge className="text-xs px-1.5 py-0 bg-teal-600">
                        Default
                      </Badge>
                    )}
                    {isExpiringSoon(b.expiryDate) && (
                      <Badge className="text-xs px-1.5 py-0 bg-yellow-600">
                        Expiring Soon
                      </Badge>
                    )}
                  </div>
                  <p className="text-slate-400 text-xs mt-0.5">
                    Exp: {new Date(b.expiryDate).toLocaleDateString("en-IN")}
                  </p>
                </div>
                <div className="text-right shrink-0 ml-4">
                  <p className="text-teal-400 font-bold">₹{b.sellingPrice}</p>
                  <p className="text-slate-500 text-xs">
                    Stock: {b.quantity} {batchPicker.unit}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

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
                className="pl-9 bg-slate-700 border-slate-600 text-slate-100 placeholder:text-slate-500 focus:border-teal-500 h-11"
                autoFocus
              />
            </div>

            {/* Results Dropdown */}
            {results.length > 0 && (
              <div className="mt-2 rounded-lg border border-slate-600 overflow-hidden divide-y divide-slate-700">
                {results.map((med) => (
                  <div
                    key={med.id}
                    className="w-full flex items-center hover:bg-slate-700 transition-colors"
                  >
                    <button
                      onClick={() => addToCart(med)}
                      className="flex-1 min-w-0 flex items-center justify-between px-4 py-3 text-left"
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
                          {med.expiryDate && isExpired(med.expiryDate) && (
                            <Badge
                              variant="destructive"
                              className="text-xs px-1.5 py-0"
                            >
                              Expired
                            </Badge>
                          )}
                          {med.expiryDate &&
                            !isExpired(med.expiryDate) &&
                            isExpiringSoon(med.expiryDate) && (
                              <Badge className="text-xs px-1.5 py-0 bg-yellow-600">
                                Expiring Soon
                              </Badge>
                            )}
                          {!med.batchId && med.expiredBatches > 0 && (
                            <Badge
                              variant="destructive"
                              className="text-xs px-1.5 py-0"
                            >
                              Stock Expired
                            </Badge>
                          )}
                          {!med.batchId && med.expiredBatches === 0 && (
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
                    {/* Overriding FEFO is a separate, explicit action — never
                        something a hurried click on the row can do by accident
                        (AD-04). Only shown when there is genuinely a choice. */}
                    {(med.batches?.length ?? 0) > 1 && (
                      <button
                        onClick={() => setBatchPicker(med)}
                        title={`Choose from ${med.batches.length} batches instead of the earliest-expiring`}
                        className="shrink-0 mr-3 px-2.5 py-1.5 rounded-md border border-slate-600 text-slate-300 text-xs hover:bg-slate-600 hover:text-white transition-colors flex items-center gap-1"
                      >
                        <Layers className="w-3.5 h-3.5" />
                        {med.batches.length} batches
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cart */}
        <Card className="bg-slate-800 border-slate-700 flex flex-col lg:flex-1 lg:overflow-hidden">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <div className="flex items-center justify-between">
              <CardTitle className="text-white text-sm font-medium flex items-center gap-2">
                <Receipt className="w-4 h-4 text-teal-400" />
                Cart
                {cart.length > 0 && (
                  <Badge className="bg-teal-600 text-black text-xs">
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

          <CardContent className="p-0 lg:flex-1 lg:overflow-y-auto">
            {cart.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500 py-16">
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
                          className="text-slate-500 hover:text-red-400 transition-colors shrink-0 mt-0.5"
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
                            className="w-7 h-7 rounded-md bg-slate-700 text-slate-100 hover:bg-slate-600 flex items-center justify-center text-sm font-bold"
                          >
                            −
                          </button>
                          <input
                            type="number"
                            value={item.quantity}
                            onChange={(e) =>
                              updateQty(idx, Number(e.target.value))
                            }
                            className="w-12 h-7 text-center bg-slate-700 border border-slate-600 rounded-md text-slate-100 text-sm"
                          />
                          <button
                            aria-label="Increase quantity"
                            onClick={() => updateQty(idx, item.quantity + 1)}
                            className="w-7 h-7 rounded-md bg-slate-700 text-slate-100 hover:bg-slate-600 flex items-center justify-center text-sm font-bold"
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
                            className="w-20 h-7 text-center bg-slate-700 border border-slate-600 rounded-md text-slate-100 text-sm"
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
                            className="w-14 h-7 text-center bg-slate-700 border border-slate-600 rounded-md text-slate-100 text-sm"
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
      <div className="w-full lg:w-80 flex flex-col gap-4 lg:shrink-0 lg:h-full lg:min-h-0">
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
                    className="pl-8 h-9 bg-slate-700 border-slate-600 text-slate-100 placeholder:text-slate-500 text-sm"
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
        <Card className="bg-slate-800 border-slate-700 flex flex-col lg:flex-1 lg:overflow-hidden lg:min-h-0">
          <CardHeader className="py-3 px-4 border-b border-slate-700 shrink-0">
            <CardTitle className="text-white text-sm font-medium">
              Bill Summary
            </CardTitle>
          </CardHeader>
          {/* Everything that varies in height — the GST breakdown and, above
              all, the Schedule H prescription form — scrolls in its own
              region instead of pushing Payment Mode and the checkout button
              off the bottom of the screen. Those two stay in a pinned footer
              below, so they're always reachable regardless of how much is
              above them. */}
          <CardContent className="pt-4 space-y-3 lg:flex-1 lg:overflow-y-auto lg:min-h-0">
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
                    className="w-20 h-7 text-right bg-slate-700 border border-slate-600 rounded text-slate-100 text-sm px-2"
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
                <span>{formatINR(cgstPaise / 100)}</span>
              </div>
              <div className="flex justify-between">
                <span>SGST</span>
                <span>{formatINR(sgstPaise / 100)}</span>
              </div>
            </div>

            {/* Schedule H register entry — FR-MED-12. Appears only when a line
                in the cart requires it, so an ordinary sale is untouched. */}
            {needsPrescription && (
              <div className="space-y-2 rounded-lg border border-red-900/60 bg-red-950/30 p-3">
                <div className="flex items-center gap-2">
                  <Badge variant="destructive" className="text-xs px-1.5 py-0">
                    Sch-H
                  </Badge>
                  <p className="text-red-200 text-xs font-medium">
                    Prescription required for this sale
                  </p>
                </div>
                <p className="text-slate-400 text-[11px] leading-snug">
                  Recorded against the invoice as the prescription register.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    placeholder="Prescriber's name"
                    value={prescription.prescriberName}
                    onChange={(e) =>
                      setPrescription((p) => ({
                        ...p,
                        prescriberName: e.target.value,
                      }))
                    }
                    className="bg-slate-700 border-slate-600 text-slate-100 h-9 text-sm col-span-2"
                  />
                  <Input
                    placeholder="Registration no."
                    value={prescription.prescriberRegNo}
                    onChange={(e) =>
                      setPrescription((p) => ({
                        ...p,
                        prescriberRegNo: e.target.value,
                      }))
                    }
                    className="bg-slate-700 border-slate-600 text-slate-100 h-9 text-sm"
                  />
                  <Input
                    type="date"
                    value={prescription.prescribedOn}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) =>
                      setPrescription((p) => ({
                        ...p,
                        prescribedOn: e.target.value,
                      }))
                    }
                    className="bg-slate-700 border-slate-600 text-slate-100 h-9 text-sm"
                  />
                  <Input
                    placeholder="Patient's name"
                    value={prescription.patientName}
                    onChange={(e) =>
                      setPrescription((p) => ({
                        ...p,
                        patientName: e.target.value,
                      }))
                    }
                    className="bg-slate-700 border-slate-600 text-slate-100 h-9 text-sm col-span-2"
                  />
                </div>
              </div>
            )}
          </CardContent>

          {/* Pinned footer — never scrolls away. Payment mode and the
              checkout button are the two things a cashier must always be able
              to reach, however tall the scrollable content above gets. */}
          <div className="p-4 pt-3 border-t border-slate-700 space-y-3 shrink-0">
            {/* Payment Mode */}
            <div className="space-y-1.5">
              <Label className="text-slate-400 text-xs">Payment Mode</Label>
              <Select
                value={paymentMode}
                onValueChange={(v) =>
                  setPaymentMode(
                    v as CreateInvoiceInput["paymentMode"] & string,
                  )
                }
              >
                <SelectTrigger className="bg-slate-700 border-slate-600 text-slate-100 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  {["CASH", "UPI", "CARD", "CREDIT"].map((mode) => (
                    <SelectItem
                      key={mode}
                      value={mode}
                      className="text-slate-100 hover:bg-slate-700 focus:bg-slate-700"
                    >
                      {mode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Actions */}
            <div className="space-y-2">
              <Button
                onClick={handleSubmit}
                disabled={submitting || cart.length === 0 || grandTotal < 0}
                className="w-full bg-teal-600 hover:bg-teal-500 text-black font-bold h-11"
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
                onClick={() =>
                  lastInvoice &&
                  printAs(String(lastInvoice.invoiceNumber ?? "invoice"))
                }
                disabled={!lastInvoice}
                className="w-full border-slate-600 text-slate-300 hover:bg-slate-700 h-9"
              >
                <Printer className="w-4 h-4 mr-2" /> Print Last Invoice
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
