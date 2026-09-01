import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Exactly one <Toaster>, and it lives in App.tsx with the position and
          rich colours the app actually wants. A second one was mounted here
          too, so every toast in the product rendered twice — once here at the
          default bottom-right and once top-right. Two of them fit on screen at
          once, which is how it stayed unnoticed: it read as a design choice
          rather than as the same message twice. */}
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
