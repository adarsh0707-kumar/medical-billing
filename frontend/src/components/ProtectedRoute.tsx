import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isAuthenticated, user } = useAuthStore();
  const location = useLocation();

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  // An account that must replace its password can reach exactly one screen.
  // Cosmetic, like every client-side check here: the API refuses the rest for
  // this account regardless of what is rendered.
  if (user?.mustChangePassword && location.pathname !== "/change-password")
    return <Navigate to="/change-password" replace />;

  return <>{children}</>;
}
