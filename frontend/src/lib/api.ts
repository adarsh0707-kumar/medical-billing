import axios, {
  type AxiosError,
  type InternalAxiosRequestConfig,
} from "axios";

const api = axios.create({
  // Empty by default: the SPA talks to /api on whatever origin served it, via
  // the nginx proxy on :80 or the Vite dev-server proxy on :5173. Set
  // VITE_API_URL only when the API genuinely lives on another host.
  // `??` rather than `||` so an explicit empty value stays empty.
  baseURL: import.meta.env.VITE_API_URL ?? "",
  headers: { "Content-Type": "application/json" },
  // The refresh token is an httpOnly cookie. Same-origin requests would carry
  // it anyway; this is what makes the cross-host VITE_API_URL case work too.
  withCredentials: true,
});

// Attach token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

const clearSession = () => {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
};

/**
 * Access tokens last 30 minutes, so a 401 is usually an expiry rather than a
 * real sign-out. One silent refresh is attempted before giving up.
 *
 * The single in-flight promise matters: a dashboard fires several requests at
 * once, and without it each 401 would start its own refresh. Because every use
 * of a refresh token rotates it, the second and later calls would present a
 * cookie the first had already retired — which the server correctly reads as
 * theft and responds to by ending every session. Concurrent refreshes would
 * therefore log the user out, reliably, every time their token expired.
 */
let refreshing: Promise<string | null> | null = null;

const refreshOnce = () => {
  refreshing ??= axios
    .post(
      `${import.meta.env.VITE_API_URL ?? ""}/api/auth/refresh`,
      {},
      { withCredentials: true },
    )
    .then((res) => {
      const token: string | undefined = res.data?.data?.token;
      if (!token) return null;
      localStorage.setItem("token", token);
      if (res.data?.data?.user) {
        localStorage.setItem("user", JSON.stringify(res.data.data.user));
      }
      return token;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
};

api.interceptors.response.use(
  (res) => res,
  async (err: AxiosError) => {
    const status = err.response?.status;
    const original = err.config as
      | (InternalAxiosRequestConfig & { _retried?: boolean })
      | undefined;

    // The account is valid but must replace its password before doing anything
    // else. Distinct from a 401: the session is fine and must not be cleared,
    // and distinct from an ordinary 403, which the user cannot act on.
    if (
      status === 403 &&
      (err.response?.data as { code?: string } | undefined)?.code ===
        "PASSWORD_CHANGE_REQUIRED" &&
      window.location.pathname !== "/change-password"
    ) {
      window.location.href = "/change-password";
      return Promise.reject(err);
    }

    const isAuthCall =
      original?.url?.includes("/api/auth/refresh") ||
      original?.url?.includes("/api/auth/login");

    if (status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      const token = await refreshOnce();
      if (token) {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      }
    }

    // Out of options: the refresh failed, or this was already a retry, or the
    // 401 came from the auth endpoints themselves.
    if (status === 401) {
      clearSession();
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }

    return Promise.reject(err);
  },
);

export default api;
