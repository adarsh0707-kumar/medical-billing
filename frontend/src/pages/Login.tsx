import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";
import api from "@/lib/api";
import { toast } from "sonner";
import { Pill, Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuthStore();

  // Empty, not pre-filled. These carried the seeded admin's credentials as
  // their initial state, which made every visit a sign-in as that one account:
  // a pharmacist or cashier had to clear two fields before they could type
  // their own. It also put a working password on screen for anyone standing at
  // the counter, and left it in the DOM of a page served to every visitor.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.post("/api/auth/login", { email, password });
      const { token, user } = res.data.data;
      login(user, token);
      toast.success(`Welcome back, ${user.name}!`);
      navigate("/dashboard");
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error.response?.data?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-teal-900 flex items-center justify-center p-4">
      {/* Background pattern */}
      <div
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, white 1px, transparent 0)",
          backgroundSize: "40px 40px",
        }}
      />

      <div className="w-full max-w-md relative z-10">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="bg-teal-500 p-3 rounded-2xl mb-3 shadow-lg shadow-teal-500/30">
            <Pill className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            MedBill Pro
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Medical Store Billing System
          </p>
        </div>

        <Card className="border-slate-700 bg-slate-800/80 backdrop-blur-sm shadow-2xl">
          <CardHeader className="pb-4">
            <h2 className="text-lg font-semibold text-white">
              Sign in to your account
            </h2>
            <p className="text-slate-400 text-sm">
              Enter your credentials to continue
            </p>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-slate-300">
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  // Lets a browser or password manager offer the right saved
                  // account per person on a shared terminal, instead of one
                  // remembered login for the machine.
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@medstore.com"
                  required
                  className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-slate-300">
                  Password
                </Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-teal-600 hover:bg-teal-500 text-white font-medium h-11 mt-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Signing
                    in...
                  </>
                ) : (
                  "Sign In"
                )}
              </Button>
            </form>

            <div className="mt-6 pt-4 border-t border-slate-700 text-center">
              <p className="text-sm text-slate-400">
                New shop?{" "}
                <Link
                  to="/signup"
                  className="text-teal-400 hover:text-teal-300 font-medium"
                >
                  Create your account
                </Link>
              </p>
            </div>

            {/* Role badges */}
            <div className="mt-6 pt-4 border-t border-slate-700">
              <p className="text-xs text-slate-500 text-center mb-2">
                Available roles
              </p>
              <div className="flex justify-center gap-2">
                {["ADMIN", "PHARMACIST", "CASHIER"].map((role) => (
                  <span
                    key={role}
                    className="text-xs px-2 py-1 rounded-full bg-slate-700 text-slate-400"
                  >
                    {role}
                  </span>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-slate-600 text-xs mt-6">
          © 2026 MedBill Pro. All rights reserved.
        </p>
      </div>
    </div>
  );
}
