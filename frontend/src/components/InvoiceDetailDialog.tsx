import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RotateCcw, Stethoscope, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import api from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import type { VoidInvoiceInput } from "@/types/api.generated";

/**
 * An invoice, and the correction path for it (FR-BILL-17).
 *
 * `POST /invoices/:id/void` has taken an optional `items[]` since partial
 * returns landed, but nothing in the client called it — the endpoint was
 * reachable only with curl and an admin token, which is no use to a pharmacist
 * who has just billed four strips instead of two.
 *
 * Kept out of `Reports.tsx` because that file is already the largest page in
 * the app and this is self-contained: an invoice list is not unique to the
 * daily summary, and the next screen that grows one can render this too.
 */

// ─── Types ─────────────────────────────────────────────

export interface InvoiceListRow {
  id: string;
  invoiceNumber: string;
  date: string;
  totalAmount: number;
  paymentMode: string;
  paymentStatus: string;
  type?: "SALE" | "CREDIT_NOTE";
  status?: "ACTIVE" | "CANCELLED";
  reversesId?: string | null;
  customer?: { name: string; phone?: string } | null;
}

interface InvoiceItemDetail {
  id: string;
  medicineName: string;
  quantity: number;
  /** Units already credited back. `quantity` never moves; this does. */
  returnedQty: number;
  unitPrice: number;
  discount: number;
  gstPercent: number;
  totalPrice: number;
  batch?: { batchNumber: string; expiryDate: string } | null;
}

/**
 * The Schedule H register entry, present only on a sale that needed one.
 *
 * Recorded at the till since FR-MED-12 and displayed nowhere: the one question
 * a pharmacist asks of a past sale — who prescribed this — could be answered
 * only from the database.
 */
interface PrescriptionDetail {
  prescriberName: string;
  prescriberRegNo: string;
  prescribedOn: string;
  patientName: string;
  notes?: string | null;
}

interface InvoiceDetail extends InvoiceListRow {
  subtotal: number;
  discountAmt: number;
  cgst: number;
  sgst: number;
  notes?: string | null;
  items: InvoiceItemDetail[];
  user?: { name: string } | null;
  prescription?: PrescriptionDetail | null;
}

const formatINR = (val: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(val);

const outstandingOn = (item: InvoiceItemDetail) =>
  item.quantity - item.returnedQty;

// ─── Dialog ────────────────────────────────────────────

interface Props {
  invoice: InvoiceListRow | null;
  onClose: () => void;
  /** Called after a return commits, so the caller can refresh its figures. */
  onReturned: () => void;
}

export default function InvoiceDetailDialog({
  invoice,
  onClose,
  onReturned,
}: Props) {
  return (
    <Dialog open={!!invoice} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-2xl">
        {/* Keyed on the invoice so opening a different row starts with an empty
            form. A `useEffect` resetting state on a prop change would do the
            same thing later and less obviously. */}
        {invoice && (
          <InvoiceDetailBody
            key={invoice.id}
            row={invoice}
            onClose={onClose}
            onReturned={onReturned}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function InvoiceDetailBody({
  row,
  onClose,
  onReturned,
}: {
  row: InvoiceListRow;
  onClose: () => void;
  onReturned: () => void;
}) {
  const { user } = useAuthStore();
  const isAdmin = user?.role === "ADMIN";

  const [reason, setReason] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [confirmingFullVoid, setConfirmingFullVoid] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { data: invoice, isLoading } = useQuery({
    queryKey: ["invoice", row.id],
    queryFn: async ({ signal }) => {
      const res = await api.get(`/api/billing/invoices/${row.id}`, { signal });
      return res.data.data as InvoiceDetail;
    },
    meta: { errorMessage: "Failed to load the invoice" },
  });

  const items = invoice?.items ?? [];
  const totalOutstanding = items.reduce((sum, i) => sum + outstandingOn(i), 0);

  /**
   * Why nothing can be returned, in the server's own words.
   *
   * Same order and the same sentences as `voidInvoice`, so the screen and the
   * API cannot tell the operator two different stories about one invoice.
   */
  const blockedReason = !invoice
    ? null
    : invoice.type === "CREDIT_NOTE"
      ? "A credit note cannot itself be voided."
      : invoice.status === "CANCELLED"
        ? "This invoice has already been voided."
        : totalOutstanding === 0
          ? "Every line on this invoice has already been returned."
          : null;

  const canReturn = isAdmin && !!invoice && !blockedReason;

  const entered = items
    .map((item) => ({
      item,
      quantity: Number(quantities[item.id] ?? ""),
    }))
    .filter((line) => Number.isFinite(line.quantity) && line.quantity > 0);

  const isFullVoid = entered.length === 0;

  const creditPreview = entered.reduce(
    (sum, { item, quantity }) => sum + (item.totalPrice / item.quantity) * quantity,
    0,
  );

  const setQty = (id: string, value: string) => {
    setQuantities((q) => ({ ...q, [id]: value }));
    // Any edit re-arms the confirmation: the sentence the operator agreed to
    // described a full void, and it no longer would.
    setConfirmingFullVoid(false);
  };

  const submit = async () => {
    if (!invoice) return;

    // Mirrors the server's own bounds. The API refuses regardless — this only
    // exists so the form does not accept something the request then rejects.
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      toast.error("Give a reason of at least 3 characters");
      return;
    }
    if (trimmed.length > 500) {
      toast.error("Reason is too long — 500 characters at most");
      return;
    }

    for (const { item, quantity } of entered) {
      if (!Number.isInteger(quantity)) {
        toast.error(`${item.medicineName}: return a whole number of units`);
        return;
      }
      const left = outstandingOn(item);
      if (quantity > left) {
        toast.error(
          `Cannot return ${quantity} of ${item.medicineName}: ${left} of ${item.quantity} still outstanding.`,
        );
        return;
      }
    }

    // An empty form means "return everything still outstanding", which is the
    // whole invoice. That is a large action to take from a form nobody filled
    // in, so it is stated and confirmed rather than merely submitted.
    if (isFullVoid && !confirmingFullVoid) {
      setConfirmingFullVoid(true);
      return;
    }

    const body: VoidInvoiceInput = isFullVoid
      ? { reason: trimmed }
      : {
          reason: trimmed,
          items: entered.map(({ item, quantity }) => ({
            invoiceItemId: item.id,
            quantity,
          })),
        };

    setSubmitting(true);
    try {
      const res = await api.post(
        `/api/billing/invoices/${invoice.id}/void`,
        body,
      );
      // The server phrases this — it knows whether the return finished the
      // invoice and what the credit note was numbered.
      toast.success(res.data?.message ?? "Return recorded");
      onReturned();
      onClose();
    } catch (err: unknown) {
      const e = err as {
        response?: { status?: number; data?: { message?: string } };
      };
      if (e.response?.status === 403) {
        // Hiding the control is not the guard; `authorize("ADMIN")` is. This is
        // what the operator sees if the two ever disagree.
        toast.error("Only an administrator can void or return an invoice.");
      } else {
        toast.error(e.response?.data?.message || "Failed to record the return");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading || !invoice) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{row.invoiceNumber}</DialogTitle>
          <DialogDescription className="text-slate-400">
            Loading the invoice…
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-teal-400" />
        </div>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          {invoice.invoiceNumber}
          {invoice.type === "CREDIT_NOTE" && (
            <Badge className="bg-amber-900 text-amber-300 text-xs">
              Credit note
            </Badge>
          )}
          {invoice.status === "CANCELLED" && (
            <Badge className="bg-red-900 text-red-300 text-xs">Voided</Badge>
          )}
        </DialogTitle>
        <DialogDescription className="text-slate-400">
          {invoice.customer?.name || "Walk-in"} ·{" "}
          {new Date(invoice.date).toLocaleString("en-IN", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          {invoice.user?.name ? ` · billed by ${invoice.user.name}` : ""}
        </DialogDescription>
      </DialogHeader>

      {/* ── Lines ── */}
      <div className="space-y-2">
        {items.map((item) => {
          const left = outstandingOn(item);
          return (
            <div
              key={item.id}
              className="flex items-start justify-between gap-3 rounded-md
                bg-slate-900/60 border border-slate-700 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-white font-medium truncate">
                  {item.medicineName}
                </p>
                <p className="text-xs text-slate-500">
                  {item.quantity} × {formatINR(item.unitPrice)}
                  {item.discount > 0 ? ` · ${item.discount}% off` : ""} ·{" "}
                  {item.gstPercent}% GST
                  {item.batch?.batchNumber
                    ? ` · batch ${item.batch.batchNumber}`
                    : ""}
                </p>
                {item.returnedQty > 0 && (
                  <p className="text-xs text-amber-400 mt-0.5">
                    {item.returnedQty} of {item.quantity} already returned
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <p className="text-sm text-teal-400 font-semibold tabular-nums">
                  {formatINR(item.totalPrice)}
                </p>
                {canReturn &&
                  (left > 0 ? (
                    <Input
                      type="number"
                      min={0}
                      max={left}
                      step={1}
                      inputMode="numeric"
                      placeholder="0"
                      aria-label={`Return quantity for ${item.medicineName}`}
                      value={quantities[item.id] ?? ""}
                      onChange={(e) => setQty(item.id, e.target.value)}
                      className="w-20 h-8 bg-slate-800 border-slate-600 text-white text-sm"
                    />
                  ) : (
                    <span className="text-xs text-slate-500 w-20 text-center">
                      Returned
                    </span>
                  ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Prescription (FR-MED-12) ── */}
      {invoice.prescription && (
        <div
          className="rounded-md border border-teal-900 bg-teal-950/30 px-3 py-2
            space-y-1"
        >
          <div className="flex items-center gap-2">
            <Stethoscope className="w-4 h-4 text-teal-400 shrink-0" />
            <h3 className="text-sm font-semibold text-white">
              Prescribed by {invoice.prescription.prescriberName}
            </h3>
          </div>
          <p className="text-xs text-slate-500">
            Reg. no {invoice.prescription.prescriberRegNo} · written{" "}
            {new Date(invoice.prescription.prescribedOn).toLocaleDateString(
              "en-IN",
              { dateStyle: "medium" },
            )}{" "}
            · for {invoice.prescription.patientName}
          </p>
          {invoice.prescription.notes && (
            <p className="text-xs text-slate-500 italic">
              {invoice.prescription.notes}
            </p>
          )}
        </div>
      )}

      <Separator className="bg-slate-700" />

      {/* ── Money ── */}
      <div className="space-y-1 text-sm">
        <Row label="Taxable value" value={formatINR(invoice.subtotal)} />
        <Row label="CGST" value={formatINR(invoice.cgst)} />
        <Row label="SGST" value={formatINR(invoice.sgst)} />
        {invoice.discountAmt > 0 && (
          <Row
            label="Bill discount"
            value={`− ${formatINR(invoice.discountAmt)}`}
          />
        )}
        <Row
          label="Total"
          value={formatINR(invoice.totalAmount)}
          className="text-white font-bold pt-1"
        />
        <p className="text-xs text-slate-500 pt-1">
          {invoice.paymentMode} · {invoice.paymentStatus}
        </p>
      </div>

      {/* ── Void / return ── */}
      {isAdmin && blockedReason && (
        <p className="text-xs text-slate-500 border-t border-slate-700 pt-3">
          {blockedReason}
        </p>
      )}

      {canReturn && (
        <div className="border-t border-slate-700 pt-3 space-y-3">
          <div className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-slate-400" />
            <h3 className="text-sm font-semibold text-white">Void / return</h3>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="void-reason"
              className="text-xs text-slate-400 block"
            >
              Reason *
            </label>
            <Input
              id="void-reason"
              value={reason}
              maxLength={500}
              placeholder="Why is this being returned?"
              onChange={(e) => setReason(e.target.value)}
              className="bg-slate-900 border-slate-600 text-white"
            />
          </div>

          {isFullVoid ? (
            <div
              className="flex gap-2 rounded-md border border-amber-800
                bg-amber-950/40 px-3 py-2"
            >
              <TriangleAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-200">
                No quantities entered, so this voids the{" "}
                <strong>whole invoice</strong> — all {totalOutstanding}{" "}
                outstanding unit
                {totalOutstanding === 1 ? "" : "s"} return to stock and a credit
                note is raised for them. Enter quantities above to return part of
                it instead.
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              Returning{" "}
              {entered.reduce((sum, line) => sum + line.quantity, 0)} unit
              {entered.reduce((sum, line) => sum + line.quantity, 0) === 1
                ? ""
                : "s"}{" "}
              across {entered.length} line{entered.length === 1 ? "" : "s"} ·
              about {formatINR(creditPreview)} credited.
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={onClose}
              disabled={submitting}
              className="text-slate-300 hover:text-slate-100 hover:bg-slate-700"
            >
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitting}
              className={
                confirmingFullVoid
                  ? "bg-red-600 hover:bg-red-500 text-white"
                  : "bg-teal-600 hover:bg-teal-500 text-black"
              }
            >
              {submitting && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              {confirmingFullVoid
                ? `Yes, void ${invoice.invoiceNumber}`
                : isFullVoid
                  ? "Void entire invoice"
                  : "Return selected units"}
            </Button>
          </DialogFooter>
        </div>
      )}
    </>
  );
}

function Row({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`flex justify-between text-slate-400 ${className}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
