import { useEffect, useState, type ReactNode } from "react";
import { session } from "../../client/session";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
const identity = z.object({
  username: z.string(),
  role: z.enum(["admin", "operator", "viewer"]),
  tenant: z.string(),
  csrf: z.string(),
  demo: z.boolean().optional(),
});
export const AuthGate = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<"loading" | "login" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState("");
  const cache = useQueryClient();
  const accept = (data: unknown) => {
    const result = identity.parse(data);
    cache.clear();
    Object.assign(session, result, { demo: result.demo ?? false });
    setState("ready");
  };
  useEffect(() => {
    void fetch("/api/auth/me")
      .then(async (response) => {
        if (response.status === 401) {
          setState("login");
          return;
        }
        if (!response.ok) throw new Error("Authentication service unavailable");
        accept(await response.json());
      })
      .catch((e) => {
        setError(String(e));
        setState("error");
      });
    const expired = () => {
      session.csrf = "";
      cache.clear();
      setState("login");
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  const login = async (event: {
    preventDefault(): void;
    currentTarget: HTMLFormElement;
  }) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
        }),
      });
      if (!response.ok)
        throw new Error("Sign in failed. Check credentials or retry later.");
      accept(await response.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed");
    }
  };
  if (state === "ready") return children;
  return (
    <main className="overlay centered">
      <section className="dialog">
        <h1>Sentinel</h1>
        <p>Sign in to your workspace</p>
        {state === "loading" ? (
          <p>Connecting…</p>
        ) : (
          <form onSubmit={(event) => void login(event)}>
            <label>
              Username
              <input name="username" autoComplete="username" required />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button className="primary">Sign in</button>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
};
