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
  logout: () => void;
}
