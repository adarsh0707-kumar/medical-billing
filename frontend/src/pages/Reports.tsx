import { useState } from "react";
import { ScrollableChart } from "@/components/layout/ScrollableChart";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import {
  BarChart3,
  TrendingUp,
  Receipt,
  Package,
  AlertTriangle,
  Download,
  Calendar,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Loader2,
  IndianRupee,
  ShoppingCart,
  FileText,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { TabSwitcher, type TabItem } from "@/components/layout/TabSwitcher";
import { Separator } from "@/components/ui/separator";
import api from "@/lib/api";
import { formatAxisINR } from "@/lib/currency";
import { downloadCsv } from "@/lib/download";
import { toast } from "sonner";
import InvoiceDetailDialog from "@/components/InvoiceDetailDialog";

// ─── Types ─────────────────────────────────────────────

interface DailySummary {
  totalInvoices: number;
  totalSales: number;
  totalCgst: number;
  totalSgst: number;
  totalGst: number;
  byPaymentMode: {
    paymentMode: string;
    _sum: { totalAmount: number };
    _count: { id: number };
  }[];
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  date: string;
  totalAmount: number;
  paymentMode: string;
  paymentStatus: string;
  /**
   * The daily summary returns whole invoice rows, so both of these are present.
   * They are what separates a sale from the credit note reversing it, and an
   * active invoice from one already voided — the list showed neither, which
   * made a negative total look like an arithmetic fault.
   */
  type?: "SALE" | "CREDIT_NOTE";
  status?: "ACTIVE" | "CANCELLED";
  reversesId?: string | null;
  customer?: { name: string; phone: string };
}

interface Batch {
  id: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  sellingPrice: number;
  medicine: { name: string; unit: string };
  supplier: { name: string };
}

interface GstTotals {
  taxable: number;
  cgst: number;
  sgst: number;
  total: number;
}

// ─── Helpers ───────────────────────────────────────────

const formatINR = (val: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(val);

const COLORS = ["#14b8a6", "#6366f1", "#f59e0b", "#ef4444", "#8b5cf6"];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// ─── Stat Card ─────────────────────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  sub,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  color: string;
  sub?: string;
}) {
  return (
    <Card className="bg-slate-800 border-slate-700">
      <CardContent className="pt-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-slate-400 text-sm">{label}</p>
            <p className="text-2xl font-bold text-white mt-1">{value}</p>
            {sub && <p className="text-slate-500 text-xs mt-1">{sub}</p>}
          </div>
          <div className={`p-3 rounded-xl ${color}`}>
            <Icon className="w-5 h-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Period reports: month and year (FR-RPT-10, FR-RPT-11) ───
//
// One component for both. A month and a year differ only in the label on each
// bar and the controls above the chart; giving them separate components meant
// the same four stat cards, the same export handler and the same empty state
// written twice, and drifting apart the first time one of them was touched.

interface PeriodSummary {
  totalSales: number;
  totalInvoices: number;
  creditNotes: number;
  totalCgst: number;
  totalSgst: number;
  totalGst: number;
}

interface PeriodBucket {
  label?: string;
  date?: string;
  day?: number;
  sales: number;
  invoices: number;
  creditNotes: number;
}

/**
 * The period's invoice register, paged from the server.
 *
 * `GET /api/billing/invoices?startDate=&endDate=` rather than an invoice list
 * bolted onto the report endpoint: that list already exists, is already
 * paginated with a capped limit, already scoped to the caller's shop and
 * already tested. A year holds tens of thousands of documents, so the one thing
 * this must not do is fetch them all and page in the browser — the page size is
 * the request.
 *
 * The bounds come from the report response, so the register and the headline
 * above it are describing the same period by construction.
 */
function PeriodRegister({
  start,
  end,
  onSelect,
}: {
  start?: string;
  end?: string;
  onSelect: (inv: Invoice) => void;
}) {
  const [page, setPage] = useState(1);

  // A new period is a new register; page 3 of the old one is meaningless here.
  const periodKey = `${start}|${end}`;
  const [seenKey, setSeenKey] = useState(periodKey);
  if (periodKey !== seenKey) {
    setSeenKey(periodKey);
    setPage(1);
  }

  const { data, isLoading } = useQuery({
    queryKey: ["period-invoices", periodKey, page],
    enabled: Boolean(start && end),
    queryFn: async () => {
      const res = await api.get(
        `/api/billing/invoices?startDate=${encodeURIComponent(start!)}` +
          `&endDate=${encodeURIComponent(end!)}&page=${page}&limit=${INVOICES_PER_PAGE}`,
      );
      return {
        invoices: res.data.data as Invoice[],
        total: res.data.pagination.total as number,
        pages: res.data.pagination.pages as number,
      };
    },
  });

  const invoices = data?.invoices ?? [];
  const totalPages = Math.max(1, data?.pages ?? 1);
  const current = Math.min(page, totalPages);
  const rangeStart = (current - 1) * INVOICES_PER_PAGE + 1;
  const rangeEnd = Math.min(current * INVOICES_PER_PAGE, data?.total ?? 0);

  return (
    <Card className="bg-slate-800 border-slate-700">
      <CardHeader className="py-3 px-4 border-b border-slate-700">
        <CardTitle className="text-white text-sm flex items-center justify-between gap-2">
          <span>Invoices ({data?.total ?? 0})</span>
          {totalPages > 1 && (
            <span className="text-slate-500 text-xs font-normal">
              {rangeStart}–{rangeEnd} of {data?.total}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-5 h-5 animate-spin text-teal-400" />
          </div>
        ) : invoices.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-slate-600">
            <p className="text-sm">No invoices in this period</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-700">
            {invoices.map((inv) => (
              <button
                key={inv.id}
                type="button"
                aria-label={`Invoice ${inv.invoiceNumber}`}
                onClick={() => onSelect(inv)}
                className="w-full flex items-center justify-between px-4 py-2.5
                  text-left hover:bg-slate-700/50 transition-colors
                  focus-visible:outline-none focus-visible:ring-1
                  focus-visible:ring-teal-500"
              >
                <div>
                  <p className="text-white text-sm font-medium flex items-center gap-1.5">
                    {inv.invoiceNumber}
                    {inv.type === "CREDIT_NOTE" && (
                      <span className="text-amber-400 text-xs font-normal">
                        credit note
                      </span>
                    )}
                    {inv.status === "CANCELLED" && (
                      <span className="text-red-400 text-xs font-normal">
                        voided
                      </span>
                    )}
                  </p>
                  <p className="text-slate-500 text-xs">
                    {inv.customer?.name || "Walk-in"} •{" "}
                    {new Date(inv.date).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                    })}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-teal-400 font-bold text-sm">
                    {formatINR(inv.totalAmount)}
                  </p>
                  <Badge
                    className={`text-xs ${
                      inv.paymentMode === "CASH"
                        ? "bg-green-900 text-green-400"
                        : inv.paymentMode === "UPI"
                          ? "bg-blue-900 text-blue-400"
                          : "bg-slate-700 text-slate-300"
                    }`}
                  >
                    {inv.paymentMode}
                  </Badge>
                </div>
              </button>
            ))}
          </div>
        )}
      </CardContent>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 border-t border-slate-700 py-2.5">
          <Button
            variant="outline"
            size="sm"
            aria-label="Previous page of invoices"
            onClick={() => setPage(current - 1)}
            disabled={current === 1}
            className="border-slate-600 text-slate-300 hover:bg-slate-700 h-8 w-8 p-0"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-slate-400 text-sm">
            Page {current} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label="Next page of invoices"
            onClick={() => setPage(current + 1)}
            disabled={current === totalPages}
            className="border-slate-600 text-slate-300 hover:bg-slate-700 h-8 w-8 p-0"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </Card>
  );
}

function PeriodReport({ granularity }: { granularity: "monthly" | "yearly" }) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Invoice | null>(null);

  const isMonthly = granularity === "monthly";
  const query = isMonthly ? `month=${month}&year=${year}` : `year=${year}`;

  const { data, isLoading: loading, refetch } = useQuery({
    queryKey: [granularity, query],
    queryFn: async () => {
      const res = await api.get(`/api/reports/${granularity}?${query}`);
      return res.data.data as {
        label: string;
        start: string;
        end: string;
        summary: PeriodSummary;
        days?: PeriodBucket[];
        months?: PeriodBucket[];
      };
    },
  });

  const summary = data?.summary;
  const buckets = (isMonthly ? data?.days : data?.months) ?? [];
  // A month is labelled by its day number, a year by the short month name.
  const chartData = buckets.map((b) => ({
    ...b,
    name: isMonthly ? String(b.day) : (b.label ?? ""),
  }));
  const hasSales = buckets.some((b) => b.sales !== 0);

  const exportPeriod = async () => {
    setExporting(true);
    try {
      const name = isMonthly
        ? `monthly-report-${year}-${String(month).padStart(2, "0")}.csv`
        : `yearly-report-${year}.csv`;
      await downloadCsv(`/api/reports/${granularity}/export?${query}`, name);
      toast.success(`${isMonthly ? "Monthly" : "Yearly"} report exported`);
    } catch {
      toast.error("Failed to export the report");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Same three-row stack on a phone as the other report controls. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3">
          {isMonthly && (
            <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
              <Calendar className="w-4 h-4 text-slate-400" />
              <select
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                aria-label="Month"
                className="bg-transparent text-white text-sm outline-none"
              >
                {MONTHS.map((m, i) => (
                  <option key={i} value={i + 1} className="bg-slate-800">
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
            {!isMonthly && <Calendar className="w-4 h-4 text-slate-400" />}
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="Year"
              className="bg-transparent text-white text-sm outline-none"
            >
              {[2024, 2025, 2026].map((y) => (
                <option key={y} value={y} className="bg-slate-800">
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button
          onClick={exportPeriod}
          size="sm"
          disabled={!hasSales || exporting}
          className="w-full sm:w-auto sm:ml-auto bg-slate-700 text-slate-100 hover:bg-slate-600 disabled:opacity-40"
        >
          {exporting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Download className="w-4 h-4 mr-2" />
          )}
          Export CSV
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-teal-400" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total Sales"
              value={formatINR(summary?.totalSales || 0)}
              icon={IndianRupee}
              color="bg-teal-600"
              sub={data?.label}
            />
            <StatCard
              label="Invoices"
              value={String(summary?.totalInvoices ?? 0)}
              icon={Receipt}
              color="bg-blue-600"
              // Named only when there are any: "0 credit notes" on a quiet
              // month reads as a warning rather than as nothing having happened.
              sub={
                summary?.creditNotes
                  ? `${summary.creditNotes} credit note${summary.creditNotes > 1 ? "s" : ""}`
                  : undefined
              }
            />
            <StatCard
              label="CGST Collected"
              value={formatINR(summary?.totalCgst || 0)}
              icon={FileText}
              color="bg-purple-600"
            />
            <StatCard
              label="SGST Collected"
              value={formatINR(summary?.totalSgst || 0)}
              icon={FileText}
              color="bg-indigo-600"
            />
          </div>

          <Card className="bg-slate-800 border-slate-700">
            <CardHeader className="py-3 px-4 border-b border-slate-700">
              <CardTitle className="text-white text-sm">
                {isMonthly ? "Sales by Day" : "Sales by Month"} — {data?.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {!hasSales ? (
                <div className="flex items-center justify-center h-40 text-slate-600">
                  <p className="text-sm">
                    No sales in {data?.label ?? "this period"}
                  </p>
                </div>
              ) : (
                // Wider floor for a month: 31 bars need more room than 12 to
                // keep their labels apart.
                <ScrollableChart className={isMonthly ? "min-w-[46rem]" : undefined}>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart
                      data={chartData}
                      margin={{ top: 8, right: 12, left: 4, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis
                        dataKey="name"
                        tick={{ fill: "#94a3b8", fontSize: 12 }}
                      />
                      <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} />
                      <Tooltip
                        cursor={{ fill: "#33415555" }}
                        formatter={(val) => formatINR(Number(val ?? 0))}
                        labelFormatter={(l) =>
                          isMonthly ? `Day ${l}` : String(l)
                        }
                        contentStyle={{
                          background: "#1e293b",
                          border: "1px solid #334155",
                          color: "#fff",
                        }}
                      />
                      <Bar dataKey="sales" fill="#14b8a6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ScrollableChart>
              )}
            </CardContent>
          </Card>

          <PeriodRegister
            start={data?.start}
            end={data?.end}
            onSelect={setSelected}
          />
        </>
      )}

      {/* Refetching on a void for the same reason the daily report does: a
          return writes a credit note into the period, so the totals and the
          breakdown move, not just the row that was returned. */}
      <InvoiceDetailDialog
        invoice={selected}
        onClose={() => setSelected(null)}
        onReturned={() => void refetch()}
      />
    </div>
  );
}

// ─── Daily Report Tab ───────────────────────────────────

// Ten rows a page. The list used to be a 240px scroll box inside a card, which
// on a phone meant a small scrolling region inside a scrolling page — the inner
// one swallowed the gesture, and the day's takings were awkward to read through.
const INVOICES_PER_PAGE = 10;

function DailyReport() {
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [invoicePage, setInvoicePage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Invoice | null>(null);

  // Summary and invoices come from one response and are now held as one value.
  // Split across two useStates they could be rendered mismatched for a frame,
  // and a slow response for an earlier date could overwrite half of a newer one.
  const {
    data,
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["daily-summary", date],
    queryFn: async ({ signal }) => {
      const res = await api.get(`/api/reports/daily-summary?date=${date}`, {
        signal,
      });
      return {
        summary: res.data.data.summary as DailySummary,
        invoices: res.data.data.invoices as Invoice[],
      };
    },
    meta: { errorMessage: "Failed to fetch daily report" },
  });

  const summary = data?.summary ?? null;
  const invoices = data?.invoices ?? [];

  const invoiceTotalPages = Math.max(
    1,
    Math.ceil(invoices.length / INVOICES_PER_PAGE),
  );
  // Clamped rather than corrected in an effect. Voiding a sale refetches the
  // day with one fewer row, which can drop the last page out from under the
  // reader; deriving the page keeps that from rendering an empty list, and
  // costs no extra render to do it.
  const page = Math.min(invoicePage, invoiceTotalPages);
  const invoiceRangeStart = (page - 1) * INVOICES_PER_PAGE + 1;
  const invoiceRangeEnd = Math.min(page * INVOICES_PER_PAGE, invoices.length);
  const pageInvoices = invoices.slice(invoiceRangeStart - 1, invoiceRangeEnd);

  const exportDaily = async () => {
    setExporting(true);
    try {
      await downloadCsv(
        `/api/reports/daily-summary/export?date=${date}`,
        `daily-summary-${date}.csv`,
      );
      toast.success("Daily summary exported");
    } catch {
      toast.error("Failed to export daily summary");
    } finally {
      setExporting(false);
    }
  };

  const paymentData =
    summary?.byPaymentMode.map((p) => ({
      name: p.paymentMode,
      amount: p._sum.totalAmount || 0,
      count: p._count.id,
    })) || [];

  return (
    <div className="space-y-4">
      {/* Date Picker. Same three-row stack as the GST controls below. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
          <Calendar className="w-4 h-4 text-slate-400" />
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              // A new day is a new list; staying on page 3 of the old one would
              // land the reader somewhere arbitrary, or on nothing at all.
              setInvoicePage(1);
            }}
            className="bg-transparent text-white text-sm outline-none"
          />
        </div>
        <Button
          onClick={() => refetch()}
          size="sm"
          className="w-full sm:w-auto bg-teal-600 hover:bg-teal-500 text-white"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
        </Button>
        <Button
          onClick={exportDaily}
          size="sm"
          disabled={invoices.length === 0 || exporting}
          // Matches the GST export: slate, so it reads as secondary to Refresh.
          className="w-full sm:w-auto sm:ml-auto bg-slate-700 text-slate-100 hover:bg-slate-600 disabled:opacity-40"
        >
          {exporting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Download className="w-4 h-4 mr-2" />
          )}
          Export CSV
        </Button>
      </div>

      {/* Stats */}
      {/* One per row on a phone. At 360px a 2-up grid gave each card ~160px,
          which clipped "₹2,130.80" and "SGST Collected" mid-word. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Sales"
          value={formatINR(summary?.totalSales || 0)}
          icon={IndianRupee}
          color="bg-teal-600"
        />
        <StatCard
          label="Invoices"
          value={String(summary?.totalInvoices || 0)}
          icon={Receipt}
          color="bg-blue-600"
        />
        <StatCard
          label="CGST Collected"
          value={formatINR(summary?.totalCgst || 0)}
          icon={FileText}
          color="bg-purple-600"
        />
        <StatCard
          label="SGST Collected"
          value={formatINR(summary?.totalSgst || 0)}
          icon={FileText}
          color="bg-indigo-600"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Payment Mode Chart */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <CardTitle className="text-white text-sm">
              Sales by Payment Mode
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 pb-6">
            {paymentData.length === 0 ? (
              <div className="flex items-center justify-center h-40 text-slate-600">
                <p className="text-sm">No data for selected date</p>
              </div>
            ) : (
              // 300 tall with 24px of margin top and bottom, against 200 and
              // none. The slice labels sit *outside* the circle, on a leader
              // line, so they need room the radius does not account for: at 200
              // a label at 12 o'clock was clipped by the card edge and one at 6
              // o'clock printed straight through the legend — "CREDIT 62%" over
              // the CREDIT swatch. Measured at 300: a label at either pole
              // clears the edge by 22px and the legend by 19px, whatever the
              // split happens to be.
              <ResponsiveContainer width="100%" height={300}>
                <PieChart margin={{ top: 24, right: 16, bottom: 24, left: 16 }}>
                  <Pie
                    data={paymentData}
                    dataKey="amount"
                    nameKey="name"
                    cx="50%"
                    cy="45%"
                    outerRadius={64}
                    label={({ name, percent }) =>
                      `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                    }
                  >
                    {paymentData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(val) => formatINR(Number(val ?? 0))}
                    contentStyle={{
                      background: "#1e293b",
                      border: "1px solid #334155",
                      color: "#fff",
                    }}
                  />
                  {/* Pushed clear of the bottom slice label, which used to
                      land on top of the swatches. */}
                  <Legend wrapperStyle={{ paddingTop: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Invoice List */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <CardTitle className="text-white text-sm flex items-center justify-between gap-2">
              <span>Invoices ({invoices.length})</span>
              {invoiceTotalPages > 1 && (
                <span className="text-slate-500 text-xs font-normal">
                  {invoiceRangeStart}–{invoiceRangeEnd} of {invoices.length}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {invoices.length === 0 ? (
              <div className="flex items-center justify-center h-40 text-slate-600">
                <p className="text-sm">No invoices for selected date</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700">
                {pageInvoices.map((inv) => (
                  <button
                    key={inv.id}
                    type="button"
                    aria-label={`Invoice ${inv.invoiceNumber}`}
                    onClick={() => setSelected(inv)}
                    className="w-full flex items-center justify-between px-4 py-2.5
                      text-left hover:bg-slate-700/50 transition-colors
                      focus-visible:outline-none focus-visible:ring-1
                      focus-visible:ring-teal-500"
                  >
                    <div>
                      <p className="text-white text-sm font-medium flex items-center gap-1.5">
                        {inv.invoiceNumber}
                        {inv.type === "CREDIT_NOTE" && (
                          <span className="text-amber-400 text-xs font-normal">
                            credit note
                          </span>
                        )}
                        {inv.status === "CANCELLED" && (
                          <span className="text-red-400 text-xs font-normal">
                            voided
                          </span>
                        )}
                      </p>
                      <p className="text-slate-500 text-xs">
                        {inv.customer?.name || "Walk-in"} •{" "}
                        {new Date(inv.date).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-teal-400 font-bold text-sm">
                        {formatINR(inv.totalAmount)}
                      </p>
                      <Badge
                        className={`text-xs ${
                          inv.paymentMode === "CASH"
                            ? "bg-green-900 text-green-400"
                            : inv.paymentMode === "UPI"
                              ? "bg-blue-900 text-blue-400"
                              : "bg-slate-700 text-slate-300"
                        }`}
                      >
                        {inv.paymentMode}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>

          {invoiceTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 border-t border-slate-700 py-2.5">
              <Button
                variant="outline"
                size="sm"
                aria-label="Previous page of invoices"
                onClick={() => setInvoicePage(page - 1)}
                disabled={page === 1}
                className="border-slate-600 text-slate-300 hover:bg-slate-700 h-8 w-8 p-0"
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <span className="text-slate-400 text-sm">
                Page {page} of {invoiceTotalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                aria-label="Next page of invoices"
                onClick={() => setInvoicePage(page + 1)}
                disabled={page === invoiceTotalPages}
                className="border-slate-600 text-slate-300 hover:bg-slate-700 h-8 w-8 p-0"
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          )}
        </Card>
      </div>

      {/* Refetching rather than patching the row: a return writes a credit note
          into the same day, so the payment-mode split and the period totals move
          too, not just the invoice that was returned. */}
      <InvoiceDetailDialog
        invoice={selected}
        onClose={() => setSelected(null)}
        onReturned={() => void refetch()}
      />
    </div>
  );
}

// ─── GST Report Tab ────────────────────────────────────

function GstReport() {
  // A GST return is the shop's filing position, not a cashier's screen — the
  // server already refuses this to anyone but ADMIN/PHARMACIST (see
  // report.routes.js). Gating the query itself, not just the tab that leads
  // here, means a stale bookmark or a future navigation change can't still
  // fire a request this role will only ever get a 403 back from.
  const { user } = useAuthStore();
  const canViewGst = user?.role === "ADMIN" || user?.role === "PHARMACIST";

  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [exporting, setExporting] = useState(false);

  // Invoices and totals are one response; docs/09 section 4 treats the totals as
  // a contract with those invoices, so they must never be rendered from
  // different requests.
  const {
    data,
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["gst-report", month, year],
    queryFn: async ({ signal }) => {
      const res = await api.get(
        `/api/reports/gst?month=${month}&year=${year}`,
        { signal },
      );
      return {
        invoices: res.data.data.invoices as Invoice[],
        totals: res.data.data.totals as GstTotals,
      };
    },
    // Never fires for a role that can only get a 403 back — and react-query's
    // default retries meant every load quietly retried that 403 several times
    // over, which is what was flooding the console.
    enabled: canViewGst,
    meta: { errorMessage: "Failed to fetch GST report" },
  });

  const invoices = data?.invoices ?? [];
  const totals = data?.totals ?? null;

  /**
   * The export is generated server-side (FR-RPT-09).
   *
   * This used to build the CSV here, and the tax columns were invented:
   * `totalAmount * 0.8` for taxable and `* 0.1` for each of CGST and SGST — a
   * hardcoded 25% rate applied to every invoice, when the system charges 0, 5,
   * 12 or 18 and the invoice already carries the real `subtotal`, `cgst` and
   * `sgst` it was written with. On live data that overstated a month's CGST by
   * 87%, in the one file that exists to be filed ([G-21](docs/08)).
   *
   * The fix is not better arithmetic here. The client does not own these
   * figures, so it should not be deriving them: the server sends the stored
   * values as exact 2 dp strings.
   */
  const exportCSV = async () => {
    setExporting(true);
    try {
      await downloadCsv(
        `/api/reports/gst/export?month=${month}&year=${year}`,
        `gst-report-${year}-${String(month).padStart(2, "0")}.csv`,
      );
      toast.success("GST report exported");
    } catch {
      toast.error("Failed to export GST report");
    } finally {
      setExporting(false);
    }
  };

  // The tab that leads here is already hidden from a cashier (see the parent
  // Reports() component), so reaching this state means a stale bookmark or a
  // direct URL — not the normal path. Explaining the restriction beats a
  // report that spins forever or renders empty with no reason given.
  if (!canViewGst) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <FileText className="w-8 h-8 text-slate-600" />
        <p className="text-slate-400 text-sm">
          GST reports are available to administrators and pharmacists.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Month/Year Selector.

          Three stacked rows on a phone — period, Generate, Export — because
          `flex-wrap` broke them at whatever width happened to run out, which
          left Export CSV alone on a line, flush right, looking unrelated to the
          controls above it. From `sm` up it is the single row it always was. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:flex-wrap">
        <div className="flex items-center gap-3">
        <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
          <Calendar className="w-4 h-4 text-slate-400" />
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="bg-transparent text-white text-sm outline-none"
          >
            {MONTHS.map((m, i) => (
              <option key={i} value={i + 1} className="bg-slate-800">
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="bg-transparent text-white text-sm outline-none"
          >
            {[2024, 2025, 2026].map((y) => (
              <option key={y} value={y} className="bg-slate-800">
                {y}
              </option>
            ))}
          </select>
        </div>
        </div>
        <Button
          onClick={() => refetch()}
          size="sm"
          className="w-full sm:w-auto bg-teal-600 hover:bg-teal-500"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate"}
        </Button>
        <Button
          onClick={exportCSV}
          size="sm"
          disabled={invoices.length === 0 || exporting}
          // Slate rather than the outline variant: white-on-dark read as the
          // primary action, competing with Generate, and its disabled state was
          // hard to tell from its enabled one.
          className="w-full sm:w-auto sm:ml-auto bg-slate-700 text-slate-100 hover:bg-slate-600 disabled:opacity-40"
        >
          {exporting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Download className="w-4 h-4 mr-2" />
          )}
          Export CSV
        </Button>
      </div>

      {/* GST Summary Cards */}
      {/* One per row on a phone. At 360px a 2-up grid gave each card ~160px,
          which clipped "₹2,130.80" and "SGST Collected" mid-word. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Taxable Amount"
          value={formatINR(totals?.taxable || 0)}
          icon={IndianRupee}
          color="bg-teal-600"
        />
        <StatCard
          label="CGST"
          value={formatINR(totals?.cgst || 0)}
          icon={FileText}
          color="bg-purple-600"
        />
        <StatCard
          label="SGST"
          value={formatINR(totals?.sgst || 0)}
          icon={FileText}
          color="bg-indigo-600"
        />
        <StatCard
          label="Total Revenue"
          value={formatINR(totals?.total || 0)}
          icon={TrendingUp}
          color="bg-blue-600"
        />
      </div>

      {/* GST Table */}
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="py-3 px-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white text-sm">
              GST Invoice Register — {MONTHS[month - 1]} {year}
            </CardTitle>
            <Badge className="bg-teal-900 text-teal-400">
              {invoices.length} invoices
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3">Invoice No</th>
                  <th className="text-left px-4 py-3">Date</th>
                  <th className="text-left px-4 py-3">Customer</th>
                  <th className="text-right px-4 py-3">Taxable</th>
                  <th className="text-right px-4 py-3">CGST</th>
                  <th className="text-right px-4 py-3">SGST</th>
                  <th className="text-right px-4 py-3">Total</th>
                  <th className="text-center px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {invoices.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="text-center py-12 text-slate-600"
                    >
                      No invoices found for {MONTHS[month - 1]} {year}
                    </td>
                  </tr>
                ) : (
                  invoices.map((inv) => (
                    <tr
                      key={inv.id}
                      className="hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="px-4 py-3 text-teal-400 font-mono text-xs">
                        {inv.invoiceNumber}
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {new Date(inv.date).toLocaleDateString("en-IN")}
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {inv.customer?.name || "Walk-in"}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">
                        {formatINR(inv.totalAmount * 0.8)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">
                        {formatINR(inv.totalAmount * 0.1)}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">
                        {formatINR(inv.totalAmount * 0.1)}
                      </td>
                      <td className="px-4 py-3 text-right text-white font-bold">
                        {formatINR(inv.totalAmount)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge
                          className={`text-xs ${
                            inv.paymentStatus === "PAID"
                              ? "bg-green-900 text-green-400"
                              : inv.paymentStatus === "PENDING"
                                ? "bg-yellow-900 text-yellow-400"
                                : "bg-slate-700 text-slate-400"
                          }`}
                        >
                          {inv.paymentStatus}
                        </Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {invoices.length > 0 && totals && (
                <tfoot>
                  <tr className="border-t-2 border-slate-600 bg-slate-700/50">
                    <td colSpan={3} className="px-4 py-3 text-white font-bold">
                      TOTAL
                    </td>
                    <td className="px-4 py-3 text-right text-white font-bold">
                      {formatINR(totals.taxable)}
                    </td>
                    <td className="px-4 py-3 text-right text-white font-bold">
                      {formatINR(totals.cgst)}
                    </td>
                    <td className="px-4 py-3 text-right text-white font-bold">
                      {formatINR(totals.sgst)}
                    </td>
                    <td className="px-4 py-3 text-right text-teal-400 font-bold text-base">
                      {formatINR(totals.total)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Stock Alerts Tab ──────────────────────────────────

function StockAlerts() {
  const [days, setDays] = useState(30);
  const [exporting, setExporting] = useState<"expiring" | "low" | null>(null);

  // One flag naming which report is downloading, rather than two booleans: the
  // two buttons sit side by side and only one can be in flight per click.
  const runExport = async (which: "expiring" | "low") => {
    setExporting(which);
    const [url, name, label] =
      which === "expiring"
        ? [
            `/api/reports/expiring/export?days=${days}`,
            `expiring-${days}-days.csv`,
            "Expiring stock",
          ]
        : [
            "/api/reports/low-stock/export?threshold=20",
            "low-stock-at-20.csv",
            "Low stock",
          ];
    try {
      await downloadCsv(url, name);
      toast.success(`${label} exported`);
    } catch {
      toast.error(`Failed to export ${label.toLowerCase()}`);
    } finally {
      setExporting(null);
    }
  };

  // Reading the clock during render is impure. Days-left is a day-granularity
  // figure, so one mount-time reading keeps every row in a render measured against
  // the same instant.
  const [nowMs] = useState(() => Date.now());

  // Two independent reports, so two queries rather than one Promise.all: only
  // the expiring list depends on `days`, and pairing them meant changing the
  // window refetched the low-stock list too. They also cache separately now, so
  // the notifications bell and this panel share the same low-stock response.
  const { data: expiring = [], isLoading: expiringLoading } = useQuery<Batch[]>(
    {
      queryKey: ["batches", "expiring", days],
      queryFn: async ({ signal }) => {
        const res = await api.get(`/api/reports/expiring?days=${days}`, {
          signal,
        });
        return res.data.data;
      },
      meta: { errorMessage: "Failed to fetch expiry alerts" },
    },
  );

  const { data: lowStock = [], isLoading: lowLoading } = useQuery<Batch[]>({
    queryKey: ["batches", "low-stock", 20],
    queryFn: async ({ signal }) => {
      const res = await api.get("/api/reports/low-stock?threshold=20", {
        signal,
      });
      return res.data.data;
    },
    meta: { errorMessage: "Failed to fetch low-stock alerts" },
  });

  // The panel showed one spinner for both lists and still does.
  const loading = expiringLoading || lowLoading;

  const getDaysLeft = (date: string) => {
    const diff = new Date(date).getTime() - nowMs;
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  };

  if (loading)
    return (
      <div className="flex items-center justify-center h-48 text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading alerts...
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Expiring Stock */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <div className="flex items-center justify-between">
              <CardTitle className="text-white text-sm flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400" />
                Expiring Stock
              </CardTitle>
              <div className="flex items-center gap-2">
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="bg-slate-700 border border-slate-600 text-white text-xs rounded px-2 py-1 outline-none"
                >
                  <option value={15}>15 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                </select>
                <Badge className="bg-yellow-900 text-yellow-400">
                  {expiring.length}
                </Badge>
                <button
                  onClick={() => runExport("expiring")}
                  disabled={expiring.length === 0 || exporting !== null}
                  aria-label="Export expiring stock CSV"
                  className="text-slate-400 hover:text-white disabled:opacity-40 disabled:hover:text-slate-400"
                >
                  {exporting === "expiring" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0 max-h-96 overflow-y-auto">
            {expiring.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-600">
                <Package className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">No expiring stock</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700/50">
                {expiring.map((batch) => {
                  const daysLeft = getDaysLeft(batch.expiryDate);
                  return (
                    <div
                      key={batch.id}
                      className="flex items-center justify-between px-4 py-3"
                    >
                      <div>
                        <p className="text-white text-sm font-medium">
                          {batch.medicine.name}
                        </p>
                        <p className="text-slate-500 text-xs mt-0.5">
                          Batch: {batch.batchNumber} • {batch.supplier.name}
                        </p>
                      </div>
                      <div className="text-right">
                        <Badge
                          className={`text-xs mb-1 ${
                            daysLeft <= 7
                              ? "bg-red-900 text-red-400"
                              : daysLeft <= 15
                                ? "bg-orange-900 text-orange-400"
                                : "bg-yellow-900 text-yellow-400"
                          }`}
                        >
                          {daysLeft}d left
                        </Badge>
                        <p className="text-slate-400 text-xs">
                          {batch.quantity} {batch.medicine.unit}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Low Stock */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <div className="flex items-center justify-between">
              <CardTitle className="text-white text-sm flex items-center gap-2">
                <Package className="w-4 h-4 text-red-400" />
                Low Stock
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge className="bg-red-900 text-red-400">
                  {lowStock.length}
                </Badge>
                <button
                  onClick={() => runExport("low")}
                  disabled={lowStock.length === 0 || exporting !== null}
                  aria-label="Export low stock CSV"
                  className="text-slate-400 hover:text-white disabled:opacity-40 disabled:hover:text-slate-400"
                >
                  {exporting === "low" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0 max-h-96 overflow-y-auto">
            {lowStock.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-600">
                <Package className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">All stock levels are healthy</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700/50">
                {lowStock.map((batch) => (
                  <div
                    key={batch.id}
                    className="flex items-center justify-between px-4 py-3"
                  >
                    <div>
                      <p className="text-white text-sm font-medium">
                        {batch.medicine.name}
                      </p>
                      <p className="text-slate-500 text-xs mt-0.5">
                        Batch: {batch.batchNumber} • {batch.supplier.name}
                      </p>
                    </div>
                    <div className="text-right">
                      <p
                        className={`text-sm font-bold ${
                          batch.quantity <= 5
                            ? "text-red-400"
                            : batch.quantity <= 10
                              ? "text-orange-400"
                              : "text-yellow-400"
                        }`}
                      >
                        {batch.quantity} {batch.medicine.unit}
                      </p>
                      <p className="text-slate-500 text-xs">
                        {formatINR(batch.sellingPrice)} / unit
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Sales Trend Tab ───────────────────────────────────

function SalesTrend() {
  const { data: trendData = [], isLoading: loading } = useQuery({
    queryKey: ["invoice-trend", 7],
    queryFn: async ({ signal }) => {
      // One grouped query on the server instead of seven daily-summary
      // requests, each of which fetched a whole day of invoices with the
      // customer joined and then read two integers off it (G-08).
      const res = await api.get("/api/reports/trend?days=7", {
        signal,
      });
      // Shaped for the chart here, in the query, so every consumer of this key
      // gets the same rows and the mapping is not redone on each render.
      return res.data.data.map(
        (t: { date: string; sales: number; invoices: number }) => ({
          date: new Date(t.date).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
          }),
          sales: t.sales,
          invoices: t.invoices,
        }),
      ) as { date: string; sales: number; invoices: number }[];
    },
    meta: { errorMessage: "Failed to fetch trend data" },
  });

  const totalWeekSales = trendData.reduce((sum, d) => sum + d.sales, 0);
  const totalWeekInvoices = trendData.reduce((sum, d) => sum + d.invoices, 0);
  const avgDailySales = totalWeekSales / 7;

  if (loading)
    return (
      <div className="flex items-center justify-center h-48 text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading trend data...
      </div>
    );

  return (
    <div className="space-y-4">
      {/* Week Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="7-Day Revenue"
          value={formatINR(totalWeekSales)}
          icon={TrendingUp}
          color="bg-teal-600"
        />
        <StatCard
          label="Total Invoices"
          value={String(totalWeekInvoices)}
          icon={ShoppingCart}
          color="bg-blue-600"
        />
        <StatCard
          label="Avg Daily Sales"
          value={formatINR(avgDailySales)}
          icon={BarChart3}
          color="bg-purple-600"
        />
      </div>

      {/* Bar Chart */}
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="py-3 px-4 border-b border-slate-700">
          <CardTitle className="text-white text-sm">
            Daily Revenue — Last 7 Days
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <ScrollableChart>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart
                data={trendData}
                margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 12 }} />
                <YAxis
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickFormatter={formatAxisINR}
                />
                <Tooltip
                  formatter={(val) => [formatINR(Number(val ?? 0)), "Revenue"]}
                  // Recharts' default bar-hover cursor is a solid, near-opaque
                  // rectangle spanning the full chart height — on this dark
                  // theme it renders tall and bright enough to be mistaken for
                  // an actual ~₹2k revenue bar on a day that had none. A
                  // faint, theme-matched fill reads as a hover highlight
                  // instead of a second, contradictory bar.
                  cursor={{ fill: "#334155", opacity: 0.35 }}
                  contentStyle={{
                    background: "#1e293b",
                    border: "1px solid #334155",
                    color: "#fff",
                    borderRadius: "8px",
                  }}
                />
                <Bar dataKey="sales" fill="#14b8a6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ScrollableChart>
        </CardContent>
      </Card>

      {/* Line Chart */}
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="py-3 px-4 border-b border-slate-700">
          <CardTitle className="text-white text-sm">
            Invoice Count — Last 7 Days
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <ScrollableChart>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart
                data={trendData}
                margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 12 }} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    background: "#1e293b",
                    border: "1px solid #334155",
                    color: "#fff",
                    borderRadius: "8px",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="invoices"
                  stroke="#6366f1"
                  strokeWidth={2}
                  dot={{ fill: "#6366f1", r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ScrollableChart>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Reports Page ─────────────────────────────────

// ─── Top sellers (FR-RPT-07) ─────────────────────────────
//
// Open to every role, like the period reports: this says what the shop sold,
// which is its own trading record. What it cost is the margin report below, and
// that one is not.
function TopSellers() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [limit, setLimit] = useState(10);
  const [exporting, setExporting] = useState(false);

  const query = `month=${month}&year=${year}&limit=${limit}`;

  const { data, isLoading: loading } = useQuery({
    queryKey: ["top-sellers", query],
    queryFn: async ({ signal }) => {
      const res = await api.get(`/api/reports/top-sellers?${query}`, { signal });
      return res.data.data as {
        label: string;
        medicines: {
          medicineId: string;
          name: string;
          unit: string;
          quantity: number;
          value: number;
        }[];
      };
    },
  });

  const medicines = data?.medicines ?? [];

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv(
        `/api/reports/top-sellers/export?${query}`,
        `top-sellers-${year}-${String(month).padStart(2, "0")}.csv`,
      );
      toast.success("Top sellers exported");
    } catch {
      toast.error("Failed to export the report");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              aria-label="Month"
              className="bg-transparent text-white text-sm outline-none"
            >
              {MONTHS.map((m, i) => (
                <option key={i} value={i + 1} className="bg-slate-800">
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="Year"
              className="bg-transparent text-white text-sm outline-none"
            >
              {[2024, 2025, 2026].map((y) => (
                <option key={y} value={y} className="bg-slate-800">
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              aria-label="How many"
              className="bg-transparent text-white text-sm outline-none"
            >
              {/* The server caps at 100; offering more than it accepts would be
                  a control that produces a 400. */}
              {[10, 20, 50].map((n) => (
                <option key={n} value={n} className="bg-slate-800">
                  Top {n}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button
          onClick={exportCsv}
          size="sm"
          disabled={!medicines.length || exporting}
          className="w-full sm:w-auto sm:ml-auto bg-slate-700 text-slate-100 hover:bg-slate-600 disabled:opacity-40"
        >
          {exporting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Download className="w-4 h-4 mr-2" />
          )}
          Export CSV
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-teal-400" />
        </div>
      ) : (
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <div className="flex items-center justify-between">
              <CardTitle className="text-white text-sm">
                Best Sellers — {MONTHS[month - 1]} {year}
              </CardTitle>
              <Badge className="bg-teal-900 text-teal-400">
                {medicines.length} medicines
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {medicines.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-12">
                Nothing sold in this period.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 text-slate-400 text-xs">
                      <th className="text-left px-4 py-3">#</th>
                      <th className="text-left px-4 py-3">Medicine</th>
                      <th className="text-right px-4 py-3">Units Sold</th>
                      <th className="text-right px-4 py-3">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {medicines.map((m, i) => (
                      <tr
                        key={m.medicineId}
                        className="border-b border-slate-700/50 text-slate-300"
                      >
                        <td className="px-4 py-3 text-slate-500">{i + 1}</td>
                        <td className="px-4 py-3 text-white">{m.name}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {m.quantity}{" "}
                          <span className="text-slate-500">{m.unit}</span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatINR(m.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Profit and margin (FR-RPT-08) ───────────────────────
//
// ADMIN only, and the tab is filtered out for everyone else rather than
// rendered disabled — the same treatment the GST tab gets, for the same reason.
// The server enforces it regardless: hiding a tab is not access control.
function MarginReport() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [exporting, setExporting] = useState(false);

  const query = `month=${month}&year=${year}`;

  const { data, isLoading: loading } = useQuery({
    queryKey: ["margin", query],
    queryFn: async ({ signal }) => {
      const res = await api.get(`/api/reports/margin?${query}`, { signal });
      return res.data.data as {
        label: string;
        margin: {
          revenue: number;
          cost: number;
          profit: number;
          marginPercent: number | null;
          unpricedLines: number;
        };
        days: { date: string; day: number; revenue: number; cost: number; profit: number }[];
      };
    },
  });

  const margin = data?.margin;
  const days = data?.days ?? [];
  const hasTrade = days.some((d) => d.revenue !== 0 || d.cost !== 0);
  const chartData = days.map((d) => ({ ...d, name: String(d.day) }));

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv(
        `/api/reports/margin/export?${query}`,
        `margin-report-${year}-${String(month).padStart(2, "0")}.csv`,
      );
      toast.success("Margin report exported");
    } catch {
      toast.error("Failed to export the report");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
            <Calendar className="w-4 h-4 text-slate-400" />
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              aria-label="Month"
              className="bg-transparent text-white text-sm outline-none"
            >
              {MONTHS.map((m, i) => (
                <option key={i} value={i + 1} className="bg-slate-800">
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-1 items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="Year"
              className="bg-transparent text-white text-sm outline-none"
            >
              {[2024, 2025, 2026].map((y) => (
                <option key={y} value={y} className="bg-slate-800">
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button
          onClick={exportCsv}
          size="sm"
          disabled={!hasTrade || exporting}
          className="w-full sm:w-auto sm:ml-auto bg-slate-700 text-slate-100 hover:bg-slate-600 disabled:opacity-40"
        >
          {exporting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Download className="w-4 h-4 mr-2" />
          )}
          Export CSV
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-teal-400" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Revenue"
              value={formatINR(margin?.revenue ?? 0)}
              icon={IndianRupee}
              color="bg-blue-600"
              sub="Excluding GST"
            />
            <StatCard
              label="Cost of Goods"
              value={formatINR(margin?.cost ?? 0)}
              icon={Package}
              color="bg-amber-600"
              sub="What the stock cost"
            />
            <StatCard
              label="Profit"
              value={formatINR(margin?.profit ?? 0)}
              icon={TrendingUp}
              color={(margin?.profit ?? 0) < 0 ? "bg-rose-600" : "bg-emerald-600"}
              sub="Revenue − cost"
            />
            <StatCard
              label="Margin"
              // Null, not zero, on a month that sold nothing — a percentage
              // here would be a claim about a period that traded.
              value={
                margin?.marginPercent === null || margin?.marginPercent === undefined
                  ? "—"
                  : `${margin.marginPercent.toFixed(2)}%`
              }
              icon={BarChart3}
              color="bg-teal-600"
              sub={
                margin?.marginPercent === null
                  ? "No sales this period"
                  : "Profit ÷ revenue"
              }
            />
          </div>

          {/* Only when there is something to warn about. A zero here is the
              normal case and a permanent banner reading "0 lines" would train
              the reader to stop seeing it. */}
          {(margin?.unpricedLines ?? 0) > 0 && (
            <Card className="bg-amber-950/40 border-amber-800">
              <CardContent className="py-3 px-4 flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-amber-200 text-sm">
                  <strong>{margin?.unpricedLines}</strong>{" "}
                  {margin?.unpricedLines === 1 ? "line" : "lines"} sold from a
                  batch with no recorded cost price, counted as costing nothing.
                  Profit above is therefore an <strong>upper bound</strong> —
                  set the purchase price on those batches to make it exact.
                </p>
              </CardContent>
            </Card>
          )}

          <Card className="bg-slate-800 border-slate-700">
            <CardHeader className="py-3 px-4 border-b border-slate-700">
              <CardTitle className="text-white text-sm">
                Daily Profit — {MONTHS[month - 1]} {year}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              {!hasTrade ? (
                <p className="text-slate-400 text-sm text-center py-12">
                  No trade in this period.
                </p>
              ) : (
                <ScrollableChart className="min-w-[46rem]">
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
                      <YAxis
                        stroke="#94a3b8"
                        fontSize={12}
                        tickFormatter={formatAxisINR}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#1e293b",
                          border: "1px solid #334155",
                          borderRadius: 8,
                          color: "#fff",
                        }}
                        formatter={(val) => formatINR(Number(val ?? 0))}
                      />
                      <Legend />
                      <Bar dataKey="revenue" name="Revenue" fill="#3b82f6" />
                      <Bar dataKey="cost" name="Cost" fill="#f59e0b" />
                      <Bar dataKey="profit" name="Profit" fill="#10b981" />
                    </BarChart>
                  </ResponsiveContainer>
                </ScrollableChart>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export default function Reports() {
  const { user } = useAuthStore();
  const canViewGst = user?.role === "ADMIN" || user?.role === "PHARMACIST";
  // Narrower than GST, and deliberately: takings are the shop's own trading
  // record, what the stock cost is not. The server enforces it with
  // `authorize("ADMIN")` — this only keeps the UI honest about it.
  const canViewMargin = user?.role === "ADMIN";
  const [tab, setTab] = useState("daily");

  // GST is filtered out for a cashier rather than rendered disabled: a tab that
  // cannot be opened is worse on a phone, where it costs a line of the dropdown
  // and explains nothing.
  const tabs: TabItem[] = [
    { value: "daily", label: "Daily Report", icon: Receipt },
    // Ordered by widening period — day, month, year — so the group reads as one
    // axis rather than an unsorted pile of reports.
    { value: "monthly", label: "Monthly Report", icon: CalendarDays },
    { value: "yearly", label: "Yearly Report", icon: CalendarRange },
    ...(canViewGst
      ? [{ value: "gst", label: "GST Report", icon: FileText }]
      : []),
    // Beside the period reports it reads from, and before the trend, so the
    // "what did we sell / what did it earn" pair sit together.
    { value: "top-sellers", label: "Top Sellers", icon: Package },
    ...(canViewMargin
      ? [{ value: "margin", label: "Profit & Margin", icon: BarChart3 }]
      : []),
    { value: "trend", label: "Sales Trend", icon: TrendingUp },
    { value: "alerts", label: "Stock Alerts", icon: AlertTriangle },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-white">Reports & Analytics</h2>
        <p className="text-slate-400 mt-1 text-sm">
          Track your sales, GST compliance and stock health
        </p>
      </div>

      <Separator className="bg-slate-800" />

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabSwitcher tabs={tabs} value={tab} onValueChange={setTab} />

        <TabsContent value="daily">
          <DailyReport />
        </TabsContent>

        <TabsContent value="monthly">
          <PeriodReport granularity="monthly" />
        </TabsContent>

        <TabsContent value="yearly">
          <PeriodReport granularity="yearly" />
        </TabsContent>
        {canViewGst && (
          <TabsContent value="gst">
            <GstReport />
          </TabsContent>
        )}
        <TabsContent value="top-sellers">
          <TopSellers />
        </TabsContent>
        {canViewMargin && (
          <TabsContent value="margin">
            <MarginReport />
          </TabsContent>
        )}
        <TabsContent value="trend">
          <SalesTrend />
        </TabsContent>
        <TabsContent value="alerts">
          <StockAlerts />
        </TabsContent>
      </Tabs>
    </div>
  );
}
