import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { cn } from "@/lib/utils";

const pageTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/billing": "Billing / POS",
  "/inventory": "Inventory",
  "/customers": "Customers",
  "/suppliers": "Suppliers",
  "/reports": "Reports",
  "/settings": "Settings",
};

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const title = pageTitles[location.pathname] || "MedBill Pro";

  // One button, two jobs, because the sidebar is two different things either
  // side of `md`: it narrows the rail on a desktop and opens the drawer on a
  // phone. Read at click time rather than tracked in state — nothing renders
  // from it, so a resize listener would buy nothing.
  const toggleNav = () => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      setCollapsed((c) => !c);
    } else {
      setDrawerOpen((o) => !o);
    }
  };

  return (
    // `overflow-x-hidden` is a backstop, not the fix. The fix is that `main`
    // carries no left margin below `md`; this stops one over-wide table or a
    // long unbroken string from making the whole document scroll sideways,
    // which is what left a white gutter beside every screen on a phone.
    <div className="min-h-screen bg-slate-950 overflow-x-hidden">
      <Sidebar
        collapsed={collapsed}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      <Topbar collapsed={collapsed} onToggle={toggleNav} title={title} />
      <main
        className={cn(
          "pt-16 min-h-screen transition-all duration-300",
          // No margin on a phone: the sidebar is off-canvas there, and 240px of
          // a 360px screen left the content 120px wide and overflowing.
          collapsed ? "md:ml-16" : "md:ml-60",
        )}
      >
        <div className="p-4 sm:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
