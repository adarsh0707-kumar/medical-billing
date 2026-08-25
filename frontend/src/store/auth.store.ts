import { create } from "zustand";
import { persist } from "zustand/middleware";
import api from "@/lib/api";
import type { AuthState, User } from "@/types";

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: (user: User, token: string) => {
        localStorage.setItem("token", token);
        set({ user, token, isAuthenticated: true });
      },

      /**
       * Ending a session is the server's job, not this store's.
       *
       * `POST /api/auth/logout` bumps `User.tokenVersion` and revokes the
       * account's refresh tokens. Without that call, clearing localStorage only
       * hides the session: the `HttpOnly` refresh cookie survives, and the
       * silent refresh in `lib/api.ts` will happily spend it for the rest of its
       * week. On a shared counter terminal that is the whole risk.
       *
       * The local half runs in `finally` because a sign-out that cannot reach
       * the server must still sign the user out here. Someone stuck on a screen
       * they cannot leave is a worse outcome than a session that outlives the
       * click, and the server-side copy still expires on its own.
       */
      logout: async () => {
        try {
          await api.post("/api/auth/logout");
        } catch {
          // Deliberately silent. There is no action the user could take, the
          // sign-out proceeds either way, and the response interceptor has
          // already handled the one case that needs handling — a 401, meaning
          // the session this was trying to end is over regardless.
        } finally {
          localStorage.removeItem("token");
          localStorage.removeItem("user");
          set({ user: null, token: null, isAuthenticated: false });
        }
      },
    }),
    { name: "auth-storage" },
  ),
);
