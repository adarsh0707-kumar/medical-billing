import { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import Layout from "@/components/layout/Layout";
import ProtectedRoute from "@/components/ProtectedRoute";
import Login from "@/pages/Login";

// Route-level code splitting. The whole application was one 987 kB chunk, so a
// cashier opening the till downloaded the reporting charts and the settings
// screens before the login form could render.
//
// Login and the layout stay eager: they are on the critical path for every
// visit, and deferring them would only add a round trip before the first paint.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Billing = lazy(() => import("./pages/Billing"));
const Reports = lazy(() => import("./pages/Reports"));
const Inventory = lazy(() => import("./pages/Inventory"));
const Customers = lazy(() => import("./pages/Customers"));
const Suppliers = lazy(() => import("./pages/Suppliers"));
const Settings = lazy(() => import("./pages/Settings"));
const ForcePasswordChange = lazy(() => import("./pages/ForcePasswordChange"));
// First-run only, and reached from the login page just once in an installation's
// life — so it is lazy, unlike Login.
const Signup = lazy(() => import("./pages/Signup"));

function RouteFallback() {
  return (
    <div className="flex items-center justify-center h-full min-h-[60vh] text-slate-500">
      <Loader2 className="w-6 h-6 animate-spin" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Public: before the first account exists there is nobody who could
              authenticate. The endpoint behind it closes itself permanently
              once one does. */}
          <Route path="/signup" element={<Signup />} />
          {/* Outside the Layout: a blocked account has nothing to navigate to,
              and showing it a sidebar of links that all return 403 would be
              worse than showing it the one thing it can actually do. */}
          <Route
            path="/change-password"
            element={
              <ProtectedRoute>
                <ForcePasswordChange />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/suppliers" element={<Suppliers />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </Suspense>
      <Toaster richColors position="top-right" />
    </BrowserRouter>
  );
}
