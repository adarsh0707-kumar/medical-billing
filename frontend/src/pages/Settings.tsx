import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  User,
  Lock,
  Users,
  Plus,
  Edit2,
  Trash2,
  Loader2,
  CheckCircle2,
  Eye,
  EyeOff,
} from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import type { UpdateUserInput } from "@/types/api.generated";
import { useAuthStore } from "@/store/auth.store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ─── Types ─────────────────────────────────────────────

interface AppUser {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "PHARMACIST" | "CASHIER";
  isActive: boolean;
  createdAt: string;
}

// ─── Helpers ───────────────────────────────────────────

const inputCls =
  "bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500 h-9";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-slate-300 text-sm">{label}</Label>
      {children}
    </div>
  );
}

const ROLE_COLORS: Record<string, string> = {
  ADMIN: "bg-red-900/50 text-red-400",
  PHARMACIST: "bg-blue-900/50 text-blue-400",
  CASHIER: "bg-green-900/50 text-green-400",
};

// ═══════════════════════════════════════════════════════
// PROFILE TAB
// ═══════════════════════════════════════════════════════

function ProfileTab() {
  const { user, login, token } = useAuthStore();
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [saving, setSaving] = useState(false);

  const handleProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.put("/api/users/profile", { name, email });
      if (token) login(res.data.data, token);
      toast.success("Profile updated!");
    } catch {
      toast.error("Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-md space-y-4">
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="py-4 px-5 border-b border-slate-700">
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <User className="w-4 h-4 text-teal-400" />
            Profile Information
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-5">
          {/* Avatar */}
          <div className="flex items-center gap-4 mb-5">
            <div
              className="w-16 h-16 rounded-full bg-gradient-to-br from-teal-500 to-teal-700
              flex items-center justify-center text-white text-2xl font-bold"
            >
              {user?.name?.charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="text-white font-semibold">{user?.name}</p>
              <Badge
                className={`text-xs mt-1 ${ROLE_COLORS[user?.role || "CASHIER"]}`}
              >
                {user?.role}
              </Badge>
            </div>
          </div>

          <form onSubmit={handleProfile} className="space-y-4">
            <Field label="Full Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className={inputCls}
              />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className={inputCls}
              />
            </Field>
            <Button
              type="submit"
              disabled={saving}
              className="w-full bg-teal-600 hover:bg-teal-500 text-white"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              Save Changes
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// CHANGE PASSWORD TAB
// ═══════════════════════════════════════════════════════

function PasswordTab() {
  // Needed for the "doesn't contain your name or email" hint, which mirrors a
  // rule the server enforces.
  const { user } = useAuthStore();
  const [form, setForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [show, setShow] = useState({
    current: false,
    new: false,
    confirm: false,
  });
  const [saving, setSaving] = useState(false);
  const [strength, setStrength] = useState(0);

  // Scores length, because that is what the server's policy actually values.
  // The old version scored one point each for an uppercase letter, a digit and
  // a symbol, which rated `Passw0rd!` above a long passphrase — the exact
  // inversion NIST SP 800-63B warns about, and the opposite of what the API
  // now accepts.
  const calcStrength = (pwd: string) => {
    let score = 0;
    if (pwd.length >= 12) score++;
    if (pwd.length >= 16) score++;
    if (pwd.length >= 20) score++;
    if (pwd.length >= 24 || /\s/.test(pwd.trim())) score++;
    setStrength(Math.min(score, 4));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.newPassword !== form.confirmPassword) {
      toast.error("Passwords do not match!");
      return;
    }
    // Matches the server (backend/src/validators/password.js). The client check
    // is a courtesy — the API refuses regardless — but it must not disagree, or
    // the form accepts something the request then rejects.
    if (form.newPassword.length < 12) {
      toast.error("Password must be at least 12 characters");
      return;
    }
    setSaving(true);
    try {
      const res = await api.put("/api/auth/change-password", {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });

      // The change signs out every other session for this account. The response
      // carries a replacement token for this one — adopt it, or the next
      // request 401s and the user is bounced to /login by their own successful
      // password change.
      const fresh: string | undefined = res.data?.data?.token;
      if (fresh) {
        localStorage.setItem("token", fresh);
        useAuthStore.setState({ token: fresh });
      }

      toast.success("Password changed. Any other devices have been signed out.");
      setForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setStrength(0);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      toast.error(e.response?.data?.message || "Failed to change password");
    } finally {
      setSaving(false);
    }
  };

  const strengthLabels = ["", "Weak", "Fair", "Good", "Strong"];
  const strengthColors = [
    "",
    "bg-red-500",
    "bg-yellow-500",
    "bg-blue-500",
    "bg-teal-500",
  ];

  return (
    <div className="max-w-md">
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="py-4 px-5 border-b border-slate-700">
          <CardTitle className="text-white text-sm flex items-center gap-2">
            <Lock className="w-4 h-4 text-teal-400" />
            Change Password
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Current Password">
              <div className="relative">
                <Input
                  type={show.current ? "text" : "password"}
                  value={form.currentPassword}
                  onChange={(e) =>
                    setForm({ ...form, currentPassword: e.target.value })
                  }
                  required
                  className={`${inputCls} pr-10`}
                />
                <button
                  type="button"
                  aria-label="Toggle password visibility"
                  onClick={() =>
                    setShow((s) => ({ ...s, current: !s.current }))
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  {show.current ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </Field>

            <Field label="New Password">
              <div className="relative">
                <Input
                  type={show.new ? "text" : "password"}
                  value={form.newPassword}
                  onChange={(e) => {
                    setForm({ ...form, newPassword: e.target.value });
                    calcStrength(e.target.value);
                  }}
                  required
                  className={`${inputCls} pr-10`}
                />
                <button
                  type="button"
                  aria-label="Toggle password visibility"
                  onClick={() => setShow((s) => ({ ...s, new: !s.new }))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  {show.new ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {form.newPassword && (
                <div className="space-y-1 mt-1">
                  <div className="flex gap-1">
                    {[1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full transition-all ${
                          i <= strength
                            ? strengthColors[strength]
                            : "bg-slate-600"
                        }`}
                      />
                    ))}
                  </div>
                  <p
                    className={`text-xs ${strengthColors[strength].replace("bg-", "text-")}`}
                  >
                    {strengthLabels[strength]}
                  </p>
                </div>
              )}
            </Field>

            <Field label="Confirm New Password">
              <div className="relative">
                <Input
                  type={show.confirm ? "text" : "password"}
                  value={form.confirmPassword}
                  onChange={(e) =>
                    setForm({ ...form, confirmPassword: e.target.value })
                  }
                  required
                  className={`${inputCls} pr-10`}
                />
                <button
                  type="button"
                  aria-label="Toggle password visibility"
                  onClick={() =>
                    setShow((s) => ({ ...s, confirm: !s.confirm }))
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  {show.confirm ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {form.confirmPassword &&
                form.newPassword !== form.confirmPassword && (
                  <p className="text-red-400 text-xs mt-1">
                    Passwords do not match
                  </p>
                )}
              {form.confirmPassword &&
                form.newPassword === form.confirmPassword && (
                  <p className="text-teal-400 text-xs mt-1 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Passwords match
                  </p>
                )}
            </Field>

            {/* Tips */}
            <div className="bg-slate-700/50 rounded-lg p-3 text-xs text-slate-400 space-y-1">
              <p className="font-medium text-slate-300 mb-1.5">
                Password requirements:
              </p>
              {[
                ["At least 12 characters", form.newPassword.length >= 12],
                [
                  "Not a common password",
                  form.newPassword.length >= 12 &&
                    !/^(password|admin|qwerty|letmein|welcome|pharmacy|medstore)/i.test(
                      form.newPassword.trim(),
                    ),
                ],
                [
                  "Doesn't contain your name or email",
                  form.newPassword.length >= 12 &&
                    !form.newPassword
                      .toLowerCase()
                      .includes((user?.email ?? "@").split("@")[0].toLowerCase()),
                ],
              ].map(([label, met]) => (
                <div key={String(label)} className="flex items-center gap-2">
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${met ? "bg-teal-400" : "bg-slate-600"}`}
                  />
                  <span className={met ? "text-teal-400" : ""}>
                    {String(label)}
                  </span>
                </div>
              ))}
            </div>

            <Button
              type="submit"
              disabled={saving}
              className="w-full bg-teal-600 hover:bg-teal-500 text-white"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              Change Password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// USER MANAGEMENT TAB (ADMIN ONLY)
// ═══════════════════════════════════════════════════════

function UsersTab() {
  const { user: currentUser } = useAuthStore();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "CASHIER" as "ADMIN" | "PHARMACIST" | "CASHIER",
    isActive: true,
  });

  const queryClient = useQueryClient();

  const { data: users = [], isLoading: loading } = useQuery<AppUser[]>({
    queryKey: ["users"],
    queryFn: async ({ signal }) => {
      const res = await api.get("/api/users", { signal });
      return res.data.data;
    },
    meta: { errorMessage: "Failed to fetch users" },
  });

  // The three write handlers below used to call `fetchUsers()` directly. Asking
  // the cache to refetch instead means any other view of the same list updates
  // with them, rather than only this component's copy.
  const refreshUsers = () =>
    queryClient.invalidateQueries({ queryKey: ["users"] });

  const openAdd = () => {
    setEditing(null);
    setForm({
      name: "",
      email: "",
      password: "",
      role: "CASHIER",
      isActive: true,
    });
    setShowForm(true);
  };

  const openEdit = (u: AppUser) => {
    setEditing(u);
    setForm({
      name: u.name,
      email: u.email,
      password: "",
      role: u.role,
      isActive: u.isActive,
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (editing) {
        // Was `Record<string, unknown>`, which accepted anything. Now the
        // backend's `updateUserSchema` decides what this may carry (NFR-22).
        const payload: UpdateUserInput = {
          name: form.name,
          email: form.email,
          role: form.role,
          isActive: form.isActive,
        };
        await api.put(`/api/users/${editing.id}`, payload);
        toast.success("User updated!");
      } else {
        if (!form.password) {
          toast.error("Password is required");
          return;
        }
        await api.post("/api/users", form);
        toast.success("User created!");
      }
      setShowForm(false);
      refreshUsers();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      toast.error(e.response?.data?.message || "Failed to save user");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (u: AppUser) => {
    if (!confirm(`Delete user ${u.name}? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/users/${u.id}`);
      toast.success("User deleted");
      refreshUsers();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      toast.error(e.response?.data?.message || "Failed to delete user");
    }
  };

  const toggleActive = async (u: AppUser) => {
    try {
      await api.put(`/api/users/${u.id}`, { ...u, isActive: !u.isActive });
      toast.success(u.isActive ? "User deactivated" : "User activated");
      refreshUsers();
    } catch {
      toast.error("Failed to update user");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-slate-400 text-sm">{users.length} total users</p>
        <Button
          onClick={openAdd}
          className="bg-teal-600 hover:bg-teal-500 text-white h-9"
        >
          <Plus className="w-4 h-4 mr-1" /> Add User
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading users...
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {users.map((u) => (
            <Card
              key={u.id}
              className={`border transition-all ${
                u.isActive
                  ? "bg-slate-800 border-slate-700"
                  : "bg-slate-800/50 border-slate-700/50 opacity-60"
              }`}
            >
              <CardContent className="pt-4 pb-3">
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center
                      text-white font-bold ${
                        u.role === "ADMIN"
                          ? "bg-red-600"
                          : u.role === "PHARMACIST"
                            ? "bg-blue-600"
                            : "bg-teal-600"
                      }`}
                    >
                      {u.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="text-white font-medium text-sm">
                          {u.name}
                        </p>
                        {u.id === currentUser?.id && (
                          <Badge className="bg-slate-600 text-slate-300 text-xs px-1.5 py-0">
                            You
                          </Badge>
                        )}
                      </div>
                      <p className="text-slate-500 text-xs">{u.email}</p>
                    </div>
                  </div>
                  <Badge className={`text-xs ${ROLE_COLORS[u.role]}`}>
                    {u.role}
                  </Badge>
                </div>

                <Separator className="bg-slate-700 mb-3" />

                {/* Actions */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <div
                      className={`w-2 h-2 rounded-full ${u.isActive ? "bg-teal-400" : "bg-slate-600"}`}
                    />
                    <span className="text-xs text-slate-500">
                      {u.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>

                  {u.id !== currentUser?.id && (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => toggleActive(u)}
                        aria-label={
                          u.isActive ? "Deactivate user" : "Activate user"
                        }
                        className="text-xs px-2 py-1 rounded-md text-slate-400
                          hover:bg-slate-700 hover:text-white transition-colors"
                      >
                        {u.isActive ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => openEdit(u)}
                        aria-label="Edit user"
                        className="p-1.5 rounded-md text-slate-400 hover:text-teal-400
                          hover:bg-slate-700 transition-colors"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(u)}
                        aria-label="Delete user"
                        className="p-1.5 rounded-md text-slate-400 hover:text-red-400
                          hover:bg-slate-700 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add/Edit User Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit User" : "Create New User"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3 mt-2">
            <Field label="Full Name *">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                placeholder="User's full name"
                className={inputCls}
              />
            </Field>
            <Field label="Email *">
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                placeholder="user@medstore.com"
                className={inputCls}
              />
            </Field>
            {!editing && (
              <Field label="Password *">
                <div className="relative">
                  <Input
                    type={showPwd ? "text" : "password"}
                    value={form.password}
                    onChange={(e) =>
                      setForm({ ...form, password: e.target.value })
                    }
                    required
                    placeholder="Min 6 characters"
                    className={`${inputCls} pr-10`}
                  />
                  <button
                    type="button"
                    aria-label="Toggle password"
                    onClick={() => setShowPwd(!showPwd)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                  >
                    {showPwd ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </Field>
            )}
            <Field label="Role *">
              <Select
                value={form.role}
                onValueChange={(v) =>
                  setForm({ ...form, role: v as typeof form.role })
                }
              >
                <SelectTrigger className="bg-slate-700 border-slate-600 text-white h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  {[
                    {
                      value: "ADMIN",
                      label: "Admin — Full access",
                      color: "text-red-400",
                    },
                    {
                      value: "PHARMACIST",
                      label: "Pharmacist — Inventory + Billing",
                      color: "text-blue-400",
                    },
                    {
                      value: "CASHIER",
                      label: "Cashier — Billing only",
                      color: "text-green-400",
                    },
                  ].map((r) => (
                    <SelectItem
                      key={r.value}
                      value={r.value}
                      className="text-white focus:bg-slate-700"
                    >
                      <span className={r.color}>{r.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {/* Role info */}
            <div className="bg-slate-700/50 rounded-lg p-3 text-xs space-y-1.5 text-slate-400">
              <p className="text-red-400 font-medium">
                Admin → Full system access + user management
              </p>
              <p className="text-blue-400 font-medium">
                Pharmacist → Inventory, billing, reports
              </p>
              <p className="text-green-400 font-medium">
                Cashier → Billing only
              </p>
            </div>

            <Separator className="bg-slate-700" />
            <div className="flex gap-2 justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowForm(false)}
                className="border-slate-600 text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-teal-600 hover:bg-teal-500 text-white"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
                {editing ? "Update User" : "Create User"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// MAIN SETTINGS PAGE
// ═══════════════════════════════════════════════════════

export default function Settings() {
  const { user } = useAuthStore();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-white">Settings</h2>
        <p className="text-slate-400 mt-1 text-sm">
          Manage your profile, security and system users
        </p>
      </div>

      <Separator className="bg-slate-800" />

      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList className="bg-slate-800 border border-slate-700">
          <TabsTrigger
            value="profile"
            className="data-[state=active]:bg-teal-600 data-[state=active]:text-white text-slate-400"
          >
            <User className="w-4 h-4 mr-2" /> Profile
          </TabsTrigger>
          <TabsTrigger
            value="password"
            className="data-[state=active]:bg-teal-600 data-[state=active]:text-white text-slate-400"
          >
            <Lock className="w-4 h-4 mr-2" /> Password
          </TabsTrigger>
          {user?.role === "ADMIN" && (
            <TabsTrigger
              value="users"
              className="data-[state=active]:bg-teal-600 data-[state=active]:text-white text-slate-400"
            >
              <Users className="w-4 h-4 mr-2" /> User Management
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="profile">
          <ProfileTab />
        </TabsContent>
        <TabsContent value="password">
          <PasswordTab />
        </TabsContent>
        {user?.role === "ADMIN" && (
          <TabsContent value="users">
            <UsersTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
