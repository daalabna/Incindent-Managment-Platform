import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { AuthGate } from "./app/components/AuthGate";
import "./style.css";
const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5000 } },
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <AuthGate>
        <App />
      </AuthGate>
    </QueryClientProvider>
  </React.StrictMode>,
);
