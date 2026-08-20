import { useState, useRef, useEffect } from "react";
import {
  Menu,
  Bell,
  Search,
  X,
  CheckCheck,
  AlertTriangle,
  Info,
  ShieldAlert,
} from "lucide-react";
import { useAuthStore } from "@/store/auth.store";
import { useNotificationStore } from "@/store/notification.store";
import { useNotifications } from "@/hooks/useNotifications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface TopbarProps {
  collapsed: boolean;
  onToggle: () => void;
  title: string;
}

function NotificationIcon({ type }: { type: string }) {
  if (type === "danger")
    return <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />;
  if (type === "warning")
    return (
      <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
    );
  return <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />;
}

export default function Topbar({ collapsed, onToggle, title }: TopbarProps) {
  const { user } = useAuthStore();
  const { notifications, unreadCount, markRead, markAllRead } =
    useNotificationStore();
  const [showNotif, setShowNotif] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fetch alerts on mount
  useNotifications();

  // Close panel on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowNotif(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Reading the clock during render is impure: two labels in one pass can straddle
  // a tick and disagree. Seed it in a lazy initialiser (the one place React allows
  // an impure read) and advance it on an interval, so every label in a render
  // agrees and relative times stay accurate while the panel is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const timeAgo = (date: Date) => {
    const diff = Math.floor((now - new Date(date).getTime()) / 60000);
    if (diff < 1) return "Just now";
    if (diff < 60) return `${diff}m ago`;
    return `${Math.floor(diff / 60)}h ago`;
  };

  return (
    <header
      className={`fixed top-0 right-0 h-16 bg-slate-900 border-b border-slate-800
      flex items-center gap-4 px-4 z-20 transition-all duration-300
      ${collapsed ? "left-16" : "left-60"}`}
    >
      {/* Toggle */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggle}
        className="text-slate-400 hover:text-white hover:bg-slate-800"
      >
        <Menu className="w-5 h-5" />
      </Button>

      {/* Page title */}
      <h1 className="text-white font-semibold text-lg hidden sm:block">
        {title}
      </h1>

      {/* Search */}
      <div className="flex-1 max-w-md hidden md:flex items-center gap-2 ml-4">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <Input
            placeholder="Search medicines, invoices..."
            className="pl-9 bg-slate-800 border-slate-700 text-white
              placeholder:text-slate-500 focus:border-teal-500 h-9"
          />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-3">
        {/* Notification Bell */}
        <div ref={panelRef} className="relative">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Notifications"
            onClick={() => setShowNotif(!showNotif)}
            className="text-slate-400 hover:text-white hover:bg-slate-800 relative"
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500
                text-white text-xs flex items-center justify-center font-bold border-2 border-slate-900"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </Button>

          {/* Notification Panel */}
          {showNotif && (
            <div
              className="absolute right-0 top-12 w-96 bg-slate-800 border border-slate-700
              rounded-xl shadow-2xl shadow-black/50 overflow-hidden z-50"
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
                <div className="flex items-center gap-2">
                  <h3 className="text-white font-semibold text-sm">
                    Notifications
                  </h3>
                  {unreadCount > 0 && (
                    <Badge className="bg-red-500 text-white text-xs px-1.5 py-0">
                      {unreadCount} new
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {unreadCount > 0 && (
                    <button
                      onClick={markAllRead}
                      aria-label="Mark all as read"
                      className="flex items-center gap-1 text-xs text-teal-400
                        hover:text-teal-300 px-2 py-1 rounded-md hover:bg-slate-700 transition-colors"
                    >
                      <CheckCheck className="w-3.5 h-3.5" />
                      Mark all read
                    </button>
                  )}
                  <button
                    onClick={() => setShowNotif(false)}
                    aria-label="Close notifications"
                    className="text-slate-500 hover:text-white p-1 rounded-md
                      hover:bg-slate-700 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Notification List */}
              <div className="max-h-96 overflow-y-auto divide-y divide-slate-700/50">
                {notifications.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-slate-600">
                    <Bell className="w-10 h-10 mb-2 opacity-20" />
                    <p className="text-sm">No notifications</p>
                    <p className="text-xs mt-1">You're all caught up!</p>
                  </div>
                ) : (
                  notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => markRead(n.id)}
                      aria-label={n.title}
                      className={cn(
                        "w-full flex items-start gap-3 px-4 py-3 text-left transition-colors",
                        "hover:bg-slate-700/50",
                        !n.read && "bg-slate-700/20",
                      )}
                    >
                      <NotificationIcon type={n.type} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p
                            className={cn(
                              "text-sm font-medium truncate",
                              n.type === "danger"
                                ? "text-red-300"
                                : n.type === "warning"
                                  ? "text-yellow-300"
                                  : "text-blue-300",
                            )}
                          >
                            {n.title}
                          </p>
                          {!n.read && (
                            <span className="w-2 h-2 rounded-full bg-teal-400 shrink-0" />
                          )}
                        </div>
                        <p className="text-slate-400 text-xs mt-0.5 line-clamp-2">
                          {n.message}
                        </p>
                        <p className="text-slate-600 text-xs mt-1">
                          {timeAgo(n.createdAt)}
                        </p>
                      </div>
                    </button>
                  ))
                )}
              </div>

              {/* Footer */}
              {notifications.length > 0 && (
                <div className="px-4 py-2 border-t border-slate-700 bg-slate-800/50">
                  <p className="text-slate-600 text-xs text-center">
                    Alerts refresh every 5 minutes
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* User avatar */}
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-full bg-teal-600 flex items-center
            justify-center text-white text-sm font-bold"
          >
            {user?.name?.charAt(0).toUpperCase()}
          </div>
          <div className="hidden sm:block">
            <p className="text-white text-sm font-medium leading-none">
              {user?.name}
            </p>
            <p className="text-slate-500 text-xs mt-0.5">{user?.role}</p>
          </div>
        </div>
      </div>
    </header>
  );
}
