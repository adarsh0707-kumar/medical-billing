import { NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";
import { toast } from "sonner";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Users,
  Truck,
  BarChart3,
  Pill,
  LogOut,
  ChevronRight,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/dashboard" },
  { icon: ShoppingCart, label: "Billing", path: "/billing" },
  { icon: Package, label: "Inventory", path: "/inventory" },
  { icon: Users, label: "Customers", path: "/customers" },
  { icon: Truck, label: "Suppliers", path: "/suppliers" },
  { icon: BarChart3, label: "Reports", path: "/reports" },
  { icon: Settings, label: "Settings", path: "/settings", adminOnly: true },
];

interface SidebarProps {
  /** The desktop rail: icons only, labels hidden. Ignored below `md`. */
  collapsed: boolean;
  /** The phone drawer, slid off-canvas until opened. Ignored from `md` up. */
  open: boolean;
  onClose: () => void;
}

/**
 * Two components in one, split by viewport.
 *
 * From `md` up it is a permanent rail that the topbar's button narrows to icons.
 * Below `md` there is no room for either width beside the content — 240px of a
 * 360px screen is not a sidebar, it is the page — so it becomes an off-canvas
 * drawer over a backdrop, and `collapsed` stops applying. That is why the
 * label-hiding classes below are all `md:hidden` rather than plain `hidden`:
 * the drawer is always full width, so it always shows its labels.
 */
export default function Sidebar({ collapsed, open, onClose }: SidebarProps) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = () => {
    // Deliberately not awaited. `logout` clears local state in a `finally`, so
    // the sign-out is already guaranteed here; waiting on the server round trip
    // would only hold the user on the page they just asked to leave. The
    // request is in flight and a client-side navigation does not cancel it.
    void logout();
    toast.success("Logged out successfully");
    navigate("/login");
  };

  const filtered = navItems.filter(
    (item) => !item.adminOnly || user?.role === "ADMIN",
  );

  return (
    <>
      {/* Backdrop. Phone only — the rail never covers anything. */}
      {open && (
        <div
          onClick={onClose}
          aria-hidden="true"
          className="fixed inset-0 bg-black/60 z-30 md:hidden"
        />
      )}

      <aside
        className={cn(
          "fixed left-0 top-0 h-full bg-slate-900 border-r border-slate-800 flex flex-col z-40 transition-all duration-300",
          // Phone: always full width, slid out of the way until opened.
          "w-60",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: always on screen, width follows the rail toggle.
          "md:translate-x-0",
          collapsed ? "md:w-16" : "md:w-60",
        )}
      >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-800">
        <div className="bg-teal-500 p-1.5 rounded-lg shrink-0">
          <Pill className="w-5 h-5 text-white" />
        </div>
        <div className={cn(collapsed && "md:hidden")}>
          <p className="text-white font-bold text-sm leading-none">
            MedBill Pro
          </p>
          <p className="text-slate-500 text-xs mt-0.5">Billing System</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-2 space-y-1 overflow-y-auto">
        {filtered.map(({ icon: Icon, label, path }) => (
          <NavLink
            key={path}
            to={path}
            // Closes the drawer as the navigation happens. A no-op for the
            // desktop rail, which is never open in the first place; without it
            // the drawer stays parked over the page it just opened.
            onClick={onClose}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all group relative",
                isActive
                  ? "bg-teal-600 text-white shadow-lg shadow-teal-900/50"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white",
              )
            }
          >
            <Icon className="w-4.5 h-4.5 shrink-0" />
            <span className={cn(collapsed && "md:hidden")}>{label}</span>
            <ChevronRight
              className={cn(
                "w-3 h-3 ml-auto opacity-0 group-hover:opacity-50 transition-opacity",
                collapsed && "md:hidden",
              )}
            />

            {/* Tooltip for the collapsed rail. Never on the drawer, which
                shows the label itself and has no hover to speak of. */}
            {collapsed && (
              <div className="hidden md:block absolute left-full ml-2 px-2 py-1 bg-slate-800 text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                {label}
              </div>
            )}
          </NavLink>
        ))}
      </nav>

      {/* User section */}
      <div className="p-2 border-t border-slate-800">
        <div className={cn("px-3 py-2 mb-1", collapsed && "md:hidden")}>
          <p className="text-white text-sm font-medium truncate">
            {user?.name}
          </p>
          <span className="text-xs px-1.5 py-0.5 rounded bg-teal-900 text-teal-400 font-medium">
            {user?.role}
          </span>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-400 hover:bg-red-900/30 hover:text-red-400 transition-all w-full group relative"
        >
          <LogOut className="w-4.5 h-4.5 shrink-0" />
          <span className={cn(collapsed && "md:hidden")}>Logout</span>
          {collapsed && (
            <div className="hidden md:block absolute left-full ml-2 px-2 py-1 bg-slate-800 text-white text-xs rounded-md opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
              Logout
            </div>
          )}
        </button>
        </div>
      </aside>
    </>
  );
}
