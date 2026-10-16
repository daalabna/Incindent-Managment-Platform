/** Filled by AuthGate from /api/auth/me or login — do not treat as authenticated until then. */
export const session = {
  csrf: "",
  username: "",
  role: "viewer" as "admin" | "operator" | "viewer",
  tenant: "",
  demo: false,
};
