import axios from "axios";

const api = axios.create({
  // Empty by default: the SPA talks to /api on whatever origin served it, via
  // the nginx proxy on :80 or the Vite dev-server proxy on :5173. Set
  // VITE_API_URL only when the API genuinely lives on another host.
  // `??` rather than `||` so an explicit empty value stays empty.
  baseURL: import.meta.env.VITE_API_URL ?? "",
  headers: { "Content-Type": "application/json" },
});

// Attach token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Handle 401 globally
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      window.location.href = "/login";
    }

    // The account is valid but must replace its password before doing anything
    // else. Distinct from a 401: the session is fine and must not be cleared,
    // and distinct from an ordinary 403, which the user cannot act on.
    if (
      err.response?.status === 403 &&
      err.response?.data?.code === "PASSWORD_CHANGE_REQUIRED" &&
      window.location.pathname !== "/change-password"
    ) {
      window.location.href = "/change-password";
    }

    return Promise.reject(err);
  },
);

export default api;
