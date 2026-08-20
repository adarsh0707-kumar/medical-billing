import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
// Fixed ✅
import {
  IndianRupee, ShoppingCart, Package, AlertTriangle,
  TrendingUp, Users, Loader2, ArrowRight, Receipt,
  Clock, CheckCircle2, XCircle, BarChart3
} from 'lucide-react'
import {
  
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import api from "@/lib/api";
import { toast } from "sonner";
import { useAuthStore } from "@/store/auth.store";

// ─── Types ─────────────────────────────────────────────

interface DailySummary {
  totalInvoices: number;
  totalSales: number;
  totalGst: number;
  totalCgst: number;
  totalSgst: number;
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
  user: { name: string };
}

interface Batch {
  id: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  medicine: { name: string; unit: string };
}

interface TrendDay {
  date: string;
  sales: number;
  invoices: number;
}

// ─── Helpers ───────────────────────────────────────────

const formatINR = (val: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(val);

const getGreeting = () => {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
};

const getDaysLeft = (date: string) =>
  Math.ceil((new Date(date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

// ─── Stat Card ─────────────────────────────────────────

function StatCard({
  label,
  value,
  icon: Icon,
  iconBg,
  sub,
  trend,
  onClick,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  iconBg: string;
  sub?: string;
  trend?: { value: string; positive: boolean };
  onClick?: () => void;
}) {
  return (
    <Card
      onClick={onClick}
      className={`bg-slate-800 border-slate-700 transition-all duration-200
        ${onClick ? "cursor-pointer hover:border-teal-600 hover:bg-slate-750" : ""}`}
    >
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <p className="text-slate-400 text-sm">{label}</p>
            <p className="text-2xl font-bold text-white mt-1 truncate">
              {value}
            </p>
            {sub && <p className="text-slate-500 text-xs mt-1">{sub}</p>}
            {trend && (
              <div
                className={`flex items-center gap-1 mt-1.5 text-xs font-medium
                ${trend.positive ? "text-teal-400" : "text-red-400"}`}
              >
                <TrendingUp
                  className={`w-3 h-3 ${!trend.positive ? "rotate-180" : ""}`}
                />
                {trend.value}
              </div>
            )}
          </div>
          <div className={`p-2.5 rounded-xl shrink-0 ml-3 ${iconBg}`}>
            <Icon className="w-5 h-5 text-white" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Payment Mode Badge ─────────────────────────────────

function PaymentBadge({ mode }: { mode: string }) {
  const styles: Record<string, string> = {
    CASH: "bg-green-900/50 text-green-400",
    UPI: "bg-blue-900/50 text-blue-400",
    CARD: "bg-purple-900/50 text-purple-400",
    CREDIT: "bg-orange-900/50 text-orange-400",
  };
  return (
    <Badge
      className={`text-xs px-2 py-0.5 ${styles[mode] || "bg-slate-700 text-slate-300"}`}
    >
      {mode}
    </Badge>
  );
}

// ─── Status Badge ───────────────────────────────────────

function StatusIcon({ status }: { status: string }) {
  if (status === "PAID")
    return <CheckCircle2 className="w-4 h-4 text-teal-400" />;
  if (status === "PENDING")
    return <Clock className="w-4 h-4 text-yellow-400" />;
  return <XCircle className="w-4 h-4 text-red-400" />;
}

// ─── Main Dashboard ────────────────────────────────────

export default function Dashboard() {
  const { user } = useAuthStore();
  const navigate = useNavigate();

  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [recentInvoices, setRecentInvoices] = useState<Invoice[]>([]);
  const [expiringBatches, setExpiringBatches] = useState<Batch[]>([]);
  const [lowStockBatches, setLowStockBatches] = useState<Batch[]>([]);
  const [trendData, setTrendData] = useState<TrendDay[]>([]);
  // Separate from the row arrays: the panels render at most ten rows but must
  // still report the real total.
  const [expiringCount, setExpiringCount] = useState(0);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [totalMedicines, setTotalMedicines] = useState(0);
  const [totalCustomers, setTotalCustomers] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      try {
        // One request. This used to be thirteen: six for the panels plus one per
        // day for the trend chart. Two of the six fetched a single row purely to
        // read pagination.total.
        const { data } = await api.get("/api/dashboard/stats");
        const d = data.data;

        setSummary(d.summary);
        setRecentInvoices(d.recentInvoices);
        // Counts come from the server now. The panels only ever rendered a
        // handful of rows but downloaded every matching batch to do it.
        setExpiringBatches(d.expiring.items);
        setExpiringCount(d.expiring.count);
        setLowStockBatches(d.lowStock.items);
        setLowStockCount(d.lowStock.count);
        setTotalMedicines(d.totals.medicines);
        setTotalCustomers(d.totals.customers);

        setTrendData(
          d.trend.map(
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
        toast.error("Failed to load the dashboard");
      } finally {
        setLoading(false);
      }
    };

    fetchAll();
  }, []);

  if (loading)
    return (
      <div className="flex items-center justify-center h-[60vh] text-slate-500">
        <Loader2 className="w-6 h-6 animate-spin mr-3" />
        <span>Loading dashboard...</span>
      </div>
    );

  const weekSales = trendData.reduce((s, d) => s + d.sales, 0);

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">
            {getGreeting()}, {user?.name?.split(" ")[0]}! 👋
          </h2>
          <p className="text-slate-400 mt-1 text-sm">
            {new Date().toLocaleDateString("en-IN", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>
        <Button
          onClick={() => navigate("/billing")}
          className="bg-teal-600 hover:bg-teal-500 text-white gap-2"
        >
          <ShoppingCart className="w-4 h-4" />
          New Bill
        </Button>
      </div>

      {/* ── Today's Stats ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Today's Sales"
          value={formatINR(summary?.totalSales || 0)}
          icon={IndianRupee}
          iconBg="bg-teal-600"
          sub={`${summary?.totalInvoices || 0} invoices`}
          onClick={() => navigate("/reports")}
        />
        <StatCard
          label="This Week"
          value={formatINR(weekSales)}
          icon={TrendingUp}
          iconBg="bg-blue-600"
          sub="Last 7 days revenue"
          onClick={() => navigate("/reports")}
        />
        <StatCard
          label="Medicines"
          value={String(totalMedicines)}
          icon={Package}
          iconBg="bg-purple-600"
          sub={`${lowStockCount} low stock`}
          onClick={() => navigate("/inventory")}
        />
        <StatCard
          label="Customers"
          value={String(totalCustomers)}
          icon={Users}
          iconBg="bg-orange-600"
          sub="Total registered"
          onClick={() => navigate("/customers")}
        />
      </div>

      {/* ── Alerts Row ── */}
      {(expiringCount > 0 || lowStockCount > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {expiringCount > 0 && (
            <div
              onClick={() => navigate("/reports")}
              className="flex items-center gap-3 bg-yellow-900/20 border border-yellow-800/50
                rounded-xl px-4 py-3 cursor-pointer hover:bg-yellow-900/30 transition-colors"
            >
              <AlertTriangle className="w-5 h-5 text-yellow-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-yellow-300 text-sm font-medium">
                  {expiringCount} batches expiring within 30 days
                </p>
                <p className="text-yellow-600 text-xs truncate">
                  {expiringBatches
                    .slice(0, 2)
                    .map((b) => b.medicine.name)
                    .join(", ")}
                  {expiringCount > 2
                    ? ` +${expiringCount - 2} more`
                    : ""}
                </p>
              </div>
              <ArrowRight className="w-4 h-4 text-yellow-600 shrink-0" />
            </div>
          )}
          {lowStockCount > 0 && (
            <div
              onClick={() => navigate("/reports")}
              className="flex items-center gap-3 bg-red-900/20 border border-red-800/50
                rounded-xl px-4 py-3 cursor-pointer hover:bg-red-900/30 transition-colors"
            >
              <Package className="w-5 h-5 text-red-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-red-300 text-sm font-medium">
                  {lowStockCount} items running low on stock
                </p>
                <p className="text-red-600 text-xs truncate">
                  {lowStockBatches
                    .slice(0, 2)
                    .map((b) => b.medicine.name)
                    .join(", ")}
                  {lowStockCount > 2
                    ? ` +${lowStockCount - 2} more`
                    : ""}
                </p>
              </div>
              <ArrowRight className="w-4 h-4 text-red-600 shrink-0" />
            </div>
          )}
        </div>
      )}

      {/* ── Charts + Recent Invoices ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Area Chart — 7 Day Trend */}
        <Card className="bg-slate-800 border-slate-700 lg:col-span-2">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <div className="flex items-center justify-between">
              <CardTitle className="text-white text-sm font-medium flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-teal-400" />
                Revenue — Last 7 Days
              </CardTitle>
              <Badge className="bg-teal-900 text-teal-400 text-xs">
                {formatINR(weekSales)} total
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-4 pb-2">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart
                data={trendData}
                margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
              >
                <defs>
                  <linearGradient
                    id="salesGradient"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  formatter={(val) => [formatINR(Number(val)), "Sales"]}
                  contentStyle={{
                    background: "#0f172a",
                    border: "1px solid #1e293b",
                    color: "#fff",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="sales"
                  stroke="#14b8a6"
                  strokeWidth={2}
                  fill="url(#salesGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Today's Payment Breakdown */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <CardTitle className="text-white text-sm font-medium">
              Today's Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            {/* GST Summary */}
            <div className="bg-slate-700/50 rounded-xl p-3 space-y-2">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                GST Collected
              </p>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">CGST</span>
                <span className="text-white">
                  {formatINR(summary?.totalCgst || 0)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">SGST</span>
                <span className="text-white">
                  {formatINR(summary?.totalSgst || 0)}
                </span>
              </div>
              <Separator className="bg-slate-600" />
              <div className="flex justify-between text-sm font-bold">
                <span className="text-slate-300">Total GST</span>
                <span className="text-teal-400">
                  {formatINR(summary?.totalGst || 0)}
                </span>
              </div>
            </div>

            {/* Payment Modes */}
            <div className="space-y-2">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                By Payment Mode
              </p>
              {summary?.byPaymentMode.length === 0 ||
              !summary?.byPaymentMode ? (
                <p className="text-slate-600 text-sm text-center py-3">
                  No transactions today
                </p>
              ) : (
                summary.byPaymentMode.map((pm) => (
                  <div
                    key={pm.paymentMode}
                    className="flex items-center justify-between"
                  >
                    <PaymentBadge mode={pm.paymentMode} />
                    <div className="text-right">
                      <p className="text-white text-sm font-medium">
                        {formatINR(pm._sum.totalAmount || 0)}
                      </p>
                      <p className="text-slate-500 text-xs">
                        {pm._count.id} bills
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Recent Invoices + Expiry Alerts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent Invoices */}
        <Card className="bg-slate-800 border-slate-700 lg:col-span-2">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <div className="flex items-center justify-between">
              <CardTitle className="text-white text-sm font-medium flex items-center gap-2">
                <Receipt className="w-4 h-4 text-teal-400" />
                Recent Invoices
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("/reports")}
                className="text-slate-400 hover:text-white text-xs h-7 gap-1"
              >
                View All <ArrowRight className="w-3 h-3" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {recentInvoices.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-600">
                <Receipt className="w-10 h-10 mb-2 opacity-20" />
                <p className="text-sm">No invoices yet</p>
                <Button
                  size="sm"
                  onClick={() => navigate("/billing")}
                  className="mt-3 bg-teal-600 hover:bg-teal-500 text-white text-xs h-8"
                >
                  Create First Invoice
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-slate-700/50">
                {recentInvoices.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-slate-700/30 transition-colors"
                  >
                    <StatusIcon status={inv.paymentStatus} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white text-sm font-medium font-mono">
                          {inv.invoiceNumber}
                        </p>
                        <PaymentBadge mode={inv.paymentMode} />
                      </div>
                      <p className="text-slate-500 text-xs mt-0.5">
                        {inv.customer?.name || "Walk-in Customer"} •{" "}
                        {new Date(inv.date).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                    <p className="text-teal-400 font-bold text-sm shrink-0">
                      {formatINR(inv.totalAmount)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Expiring Soon */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="py-3 px-4 border-b border-slate-700">
            <div className="flex items-center justify-between">
              <CardTitle className="text-white text-sm font-medium flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400" />
                Expiring Soon
              </CardTitle>
              {expiringCount > 0 && (
                <Badge className="bg-yellow-900 text-yellow-400 text-xs">
                  {expiringCount}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {expiringCount === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-600">
                <CheckCircle2 className="w-10 h-10 mb-2 opacity-20" />
                <p className="text-sm">All stock is fresh!</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700/50 max-h-72 overflow-y-auto">
                {expiringBatches.slice(0, 8).map((batch) => {
                  const daysLeft = getDaysLeft(batch.expiryDate);
                  return (
                    <div
                      key={batch.id}
                      className="flex items-center justify-between px-4 py-3"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm truncate">
                          {batch.medicine.name}
                        </p>
                        <p className="text-slate-500 text-xs">
                          {batch.quantity} {batch.medicine.unit} left
                        </p>
                      </div>
                      <Badge
                        className={`text-xs shrink-0 ml-2 ${
                          daysLeft <= 7
                            ? "bg-red-900 text-red-400"
                            : daysLeft <= 15
                              ? "bg-orange-900 text-orange-400"
                              : "bg-yellow-900 text-yellow-400"
                        }`}
                      >
                        {daysLeft}d
                      </Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
