import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, ShieldAlert } from "lucide-react";
import api from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Shown when an account must replace its password before it can do anything —
 * the seeded bootstrap admin, whose password is published in the repository
 * (threat T-2).
 *
 * This screen is a courtesy, not the control. The API refuses every other route
 * for a flagged account regardless of what the client renders, so skipping this
 * page gets you a 403, not access. See
 * `backend/src/middlewares/password-change.middleware.js`.
 */
export default function ForcePasswordChange() {
  const { user, login, token, logout } = useAuthStore();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirm) {
      toast.error("The two new passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      toast.error("The new password must be different from the current one.");
      return;
    }

    setSaving(true);
    try {
      const res = await api.put("/api/auth/change-password", {
        currentPassword,
        newPassword,
      });

      // Changing the password revokes every token for the account, this one
      // included, and the response carries a replacement. Store it before the
      // next request: calling /me with the old token would 401, and the axios
      // interceptor would clear the session and bounce to /login — turning a
      // successful password change into an apparent failure.
      const fresh: string | undefined = res.data?.data?.token;
      if (fresh) localStorage.setItem("token", fresh);

      // The server cleared the flag, so the cached user is now stale. Refresh it
      // rather than guessing, so the app's idea of the account matches the API's.
      const me = await api.get("/api/auth/me");
      const active = fresh ?? token;
      if (active) login(me.data.data.user, active);

      toast.success("Password changed. You can use the system now.");
      navigate("/dashboard", { replace: true });
    } catch (err) {
      const message =
        (err as { response?: { data?: { message?: string } } }).response?.data
          ?.message ?? "Could not change the password.";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex items-start gap-3">
            <ShieldAlert className="w-6 h-6 text-yellow-400 shrink-0 mt-0.5" />
            <div>
              <h1 className="text-white font-semibold text-lg">
                Choose a new password
              </h1>
              <p className="text-slate-400 text-sm mt-1">
                This account still uses its setup password, which is publicly
                known. Nothing else will work until it is replaced.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="current" className="text-slate-300">
                Current password
              </Label>
              <Input
                id="current"
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="bg-slate-800 border-slate-700 text-white"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="next" className="text-slate-300">
                New password
              </Label>
              <Input
                id="next"
                type="password"
                required
                minLength={12}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="bg-slate-800 border-slate-700 text-white"
              />
              <p className="text-slate-500 text-xs">
                At least 12 characters. Avoid common passwords and anything
                containing your name or email.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirm" className="text-slate-300">
                Confirm new password
              </Label>
              <Input
                id="confirm"
                type="password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="bg-slate-800 border-slate-700 text-white"
              />
            </div>

            <Button
              type="submit"
              disabled={saving}
              className="w-full bg-teal-600 hover:bg-teal-500 text-black font-medium h-11"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...
                </>
              ) : (
                "Change password and continue"
              )}
            </Button>
          </form>

          <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
            <span>Signed in as {user?.email}</span>
            <button
              type="button"
              onClick={() => {
                // See Sidebar's handleLogout: not awaited on purpose. Note the
                // logout route carries no requirePasswordChange guard, so this
                // works even though every other route is refusing this account.
                void logout();
                navigate("/login", { replace: true });
              }}
              className="text-slate-400 hover:text-white underline underline-offset-2"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
