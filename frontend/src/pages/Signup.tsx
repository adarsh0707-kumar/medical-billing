import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Pill, Eye, EyeOff, Loader2, ShieldCheck, Lock } from "lucide-react";
import api from "@/lib/api";
import type { SignupInput } from "@/types/api.generated";
import { useAuthStore } from "@/store/auth.store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * First-run setup — creating the one administrator account.
 *
 * This is not open registration, and the page says so rather than letting
 * someone discover it from a 409. The endpoint closes itself permanently once
 * an account exists, because every authenticated role can read customer
 * purchase history, which in a pharmacy reveals health conditions.
 *
 * As with `ForcePasswordChange`, what is rendered here is a courtesy: the
 * server refuses a second signup regardless of what the client shows.
 */
export default function Signup() {
  const navigate = useNavigate();
  const { login } = useAuthStore();

  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/auth/setup-status")
      .then((res) => {
        if (!cancelled) setNeedsSetup(Boolean(res.data?.data?.needsSetup));
      })
      // A failed check is not a reason to offer a form that cannot work. If the
      // API is unreachable the safe render is the closed state, which sends the
      // reader to their administrator rather than into a request that 409s.
      .catch(() => {
        if (!cancelled) setNeedsSetup(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirm) {
      toast.error("The two passwords do not match.");
      return;
    }

    setSaving(true);
    try {
      // Typed from the server's own Zod schema (NFR-22), so adding a required
      // field to signupSchema turns this into a build error rather than a 400.
      const body: SignupInput = { name, email, password };
      const res = await api.post("/api/auth/signup", body);
      const { token, user } = res.data.data;
      login(user, token);
      toast.success(`Welcome, ${user.name}. This system is now yours to set up.`);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      const error = err as {
        response?: {
          data?: { message?: string; errors?: { message?: string }[] };
        };
      };
      // The server returns field errors for a rejected password; showing the
      // first is more use than "Validation failed", which tells the operator
      // nothing about what to type instead.
      const detail = error.response?.data?.errors?.[0]?.message;
      toast.error(
        detail ?? error.response?.data?.message ?? "Could not create the account.",
      );
      // A 409 means somebody claimed the installation while this form was open.
      if (error.response?.data?.message?.includes("already has an account")) {
        setNeedsSetup(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-teal-900 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, white 1px, transparent 0)",
          backgroundSize: "40px 40px",
        }}
      />

      <div className="w-full max-w-md relative z-10">
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
          {checking ? (
            <CardContent className="py-12 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
            </CardContent>
          ) : !needsSetup ? (
            // The closed state. Deliberately not an error: nothing has gone
            // wrong, this installation simply already belongs to someone.
            <CardContent className="py-8 space-y-4 text-center">
              <div className="flex justify-center">
                <div className="bg-slate-700/60 p-3 rounded-full">
                  <Lock className="w-6 h-6 text-slate-400" />
                </div>
              </div>
              <div className="space-y-1.5">
                <h2 className="text-lg font-semibold text-white">
                  Signup is closed
                </h2>
                <p className="text-slate-400 text-sm leading-relaxed">
                  This system already has an account. Accounts are created by an
                  administrator, in Settings — so ask yours to add you.
                </p>
              </div>
              <Button
                asChild
                variant="outline"
                className="w-full border-slate-600 bg-slate-700/50 text-slate-200 hover:bg-slate-700 hover:text-white"
              >
                <Link to="/login">Back to sign in</Link>
              </Button>
            </CardContent>
          ) : (
            <>
              <CardHeader className="pb-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="w-5 h-5 text-teal-400 shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-lg font-semibold text-white">
                      Create the administrator account
                    </h2>
                    <p className="text-slate-400 text-sm mt-1">
                      Nobody has claimed this installation yet. The account you
                      create is the administrator, and this page closes for good
                      once it exists.
                    </p>
                  </div>
                </div>
              </CardHeader>

              <CardContent>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name" className="text-slate-300">
                      Your name
                    </Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Priya Nair"
                      required
                      minLength={2}
                      className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-slate-300">
                      Email
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@yourpharmacy.com"
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
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••••••"
                        required
                        minLength={12}
                        className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500 pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                    <p className="text-slate-500 text-xs">
                      At least 12 characters. A passphrase of a few words beats a
                      short one with symbols in it.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirm" className="text-slate-300">
                      Confirm password
                    </Label>
                    <Input
                      id="confirm"
                      type={showPassword ? "text" : "password"}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      required
                      className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={saving}
                    className="w-full bg-teal-600 hover:bg-teal-500 text-white font-medium h-11 mt-2"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />{" "}
                        Creating account...
                      </>
                    ) : (
                      "Create account and sign in"
                    )}
                  </Button>
                </form>

                <div className="mt-6 pt-4 border-t border-slate-700 text-center">
                  <p className="text-sm text-slate-400">
                    Already have an account?{" "}
                    <Link
                      to="/login"
                      className="text-teal-400 hover:text-teal-300 font-medium"
                    >
                      Sign in
                    </Link>
                  </p>
                </div>
              </CardContent>
            </>
          )}
        </Card>

        <p className="text-center text-slate-600 text-xs mt-6">
          © 2026 MedBill Pro. All rights reserved.
        </p>
      </div>
    </div>
  );
}
