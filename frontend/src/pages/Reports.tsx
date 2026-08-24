import { useState, useEffect } from "react";
import {
  BarChart3,
  TrendingUp,
  Receipt,
  Package,
  AlertTriangle,
  Download,
  Calendar,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import api from "@/lib/api";
import { downloadCsv } from "@/lib/download";
import { toast } from "sonner";

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

// ─── Daily Report Tab ───────────────────────────────────

function DailyReport() {
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const exportDaily = async () => {
    setExporting(true);
    try {
      await downloadCsv(
        `/api/billing/invoices/daily-summary/export?date=${date}`,
        `daily-summary-${date}.csv`,
      );
      toast.success("Daily summary exported");
    } catch {
      toast.error("Failed to export daily summary");
    } finally {
      setExporting(false);
    }
  };

  const fetchDaily = async () => {
    setLoading(true);
    try {
      const res = await api.get(
        `/api/billing/invoices/daily-summary?date=${date}`,
      );
      setSummary(res.data.data.summary);
      setInvoices(res.data.data.invoices);
    } catch {
      toast.error("Failed to fetch daily report");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDaily();
  }, [date]);

  const paymentData =
    summary?.byPaymentMode.map((p) => ({
      name: p.paymentMode,
      amount: p._sum.totalAmount || 0,
      count: p._count.id,
    })) || [];

  return (
    <div className="space-y-4">
      {/* Date Picker */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
          <Calendar className="w-4 h-4 text-slate-400" />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="bg-transparent text-white text-sm outline-none"
          />
        </div>
        <Button
          onClick={fetchDaily}
          size="sm"
          className="bg-teal-600 hover:bg-teal-500 text-white"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
        </Button>
        <Button
          onClick={exportDaily}
          size="sm"
          variant="outline"
          disabled={invoices.length === 0 || exporting}
          className="border-slate-600 text-slate-300 hover:bg-slate-700 ml-auto"
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
          <CardContent className="pt-4">
            {paymentData.length === 0 ? (
              <div className="flex items-center justify-center h-40 text-slate-600">
                <p className="text-sm">No data for selected date</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={paymentData}
                    dataKey="amount"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={70}
                    label={({ name, percent }) =>
                      `${name} ${((percent ?? 0 )* 100).toFixed(0)}%`
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
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Invoice List */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <CardTitle className="text-white text-sm">
              Invoices ({invoices.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 max-h-60 overflow-y-auto">
            {invoices.length === 0 ? (
              <div className="flex items-center justify-center h-40 text-slate-600">
                <p className="text-sm">No invoices for selected date</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700">
                {invoices.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between px-4 py-2.5"
                  >
                    <div>
                      <p className="text-white text-sm font-medium">
                        {inv.invoiceNumber}
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

// ─── GST Report Tab ────────────────────────────────────

function GstReport() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [totals, setTotals] = useState<GstTotals | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fetchGst = async () => {
    setLoading(true);
    try {
      const res = await api.get(
        `/api/billing/invoices/gst-report?month=${month}&year=${year}`,
      );
      setInvoices(res.data.data.invoices);
      setTotals(res.data.data.totals);
    } catch {
      toast.error("Failed to fetch GST report");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGst();
  }, [month, year]);

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
        `/api/billing/invoices/gst-report/export?month=${month}&year=${year}`,
        `gst-report-${year}-${String(month).padStart(2, "0")}.csv`,
      );
      toast.success("GST report exported");
    } catch {
      toast.error("Failed to export GST report");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Month/Year Selector */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
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
        <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
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
        <Button
          onClick={fetchGst}
          size="sm"
          className="bg-teal-600 hover:bg-teal-500"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate"}
        </Button>
        <Button
          onClick={exportCSV}
          size="sm"
          variant="outline"
          disabled={invoices.length === 0 || exporting}
          className="border-slate-600 text-slate-300 hover:bg-slate-700 ml-auto"
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
  const [expiring, setExpiring] = useState<Batch[]>([]);
  const [lowStock, setLowStock] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [exporting, setExporting] = useState<"expiring" | "low" | null>(null);

  // One flag naming which report is downloading, rather than two booleans: the
  // two buttons sit side by side and only one can be in flight per click.
  const runExport = async (which: "expiring" | "low") => {
    setExporting(which);
    const [url, name, label] =
      which === "expiring"
        ? [
            `/api/inventory/batches/expiring/export?days=${days}`,
            `expiring-${days}-days.csv`,
            "Expiring stock",
          ]
        : [
            "/api/inventory/batches/low-stock/export?threshold=20",
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

  useEffect(() => {
    const fetch = async () => {
      setLoading(true);
      try {
        const [expRes, lowRes] = await Promise.all([
          api.get(`/api/inventory/batches/expiring?days=${days}`),
          api.get("/api/inventory/batches/low-stock?threshold=20"),
        ]);
        setExpiring(expRes.data.data);
        setLowStock(lowRes.data.data);
      } catch {
        toast.error("Failed to fetch alerts");
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, [days]);

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
  const [trendData, setTrendData] = useState<
    { date: string; sales: number; invoices: number }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTrend = async () => {
      try {
        // One grouped query on the server instead of seven daily-summary
        // requests, each of which fetched a whole day of invoices with the
        // customer joined and then read two integers off it (G-08).
        const res = await api.get("/api/billing/invoices/trend?days=7");
        setTrendData(
          res.data.data.map(
            (t: { date: string; sales: number; invoices: number }) => ({
              date: new Date(t.date).toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
              }),
              sales: t.sales,
              invoices: t.invoices,
            }),
          ),
        );
      } catch {
        toast.error("Failed to fetch trend data");
      } finally {
        setLoading(false);
      }
    };

    fetchTrend();
  }, []);

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
          <ResponsiveContainer width="100%" height={250}>
            <BarChart
              data={trendData}
              margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 12 }} />
              <YAxis
                tick={{ fill: "#94a3b8", fontSize: 12 }}
                tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip
                formatter={(val) => [formatINR(Number(val ?? 0)), "Revenue"]}
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
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Reports Page ─────────────────────────────────

export default function Reports() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-white">Reports & Analytics</h2>
        <p className="text-slate-400 mt-1 text-sm">
          Track your sales, GST compliance and stock health
        </p>
      </div>

      <Separator className="bg-slate-800" />

      <Tabs defaultValue="daily" className="space-y-4">
        <TabsList className="bg-slate-800 border border-slate-700">
          <TabsTrigger
            value="daily"
            className="data-[state=active]:bg-teal-600 data-[state=active]:text-white text-slate-400"
          >
            <Receipt className="w-4 h-4 mr-2" /> Daily Report
          </TabsTrigger>
          <TabsTrigger
            value="gst"
            className="data-[state=active]:bg-teal-600 data-[state=active]:text-white text-slate-400"
          >
            <FileText className="w-4 h-4 mr-2" /> GST Report
          </TabsTrigger>
          <TabsTrigger
            value="trend"
            className="data-[state=active]:bg-teal-600 data-[state=active]:text-white text-slate-400"
          >
            <TrendingUp className="w-4 h-4 mr-2" /> Sales Trend
          </TabsTrigger>
          <TabsTrigger
            value="alerts"
            className="data-[state=active]:bg-teal-600 data-[state=active]:text-white text-slate-400"
          >
            <AlertTriangle className="w-4 h-4 mr-2" /> Stock Alerts
          </TabsTrigger>
        </TabsList>

        <TabsContent value="daily">
          <DailyReport />
        </TabsContent>
        <TabsContent value="gst">
          <GstReport />
        </TabsContent>
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
