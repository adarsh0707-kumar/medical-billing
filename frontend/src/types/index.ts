export type Role = "ADMIN" | "PHARMACIST" | "CASHIER";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** While true the API refuses every route but /auth/me and change-password. */
  mustChangePassword?: boolean;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (user: User, token: string) => void;
  /**
   * Asynchronous because it ends the session server-side before clearing local
   * state. Callers may fire and forget — the local half is guaranteed by a
   * `finally` — but must not assume it has completed on the next line.
   */
  logout: () => Promise<void>;
}
