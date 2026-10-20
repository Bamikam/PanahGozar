import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { AuthProvider } from "./auth.js";
import { I18nProvider } from "./i18n.js";
import { ThemeProvider } from "./theme.js";
import { ToastProvider } from "./toast.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");

createRoot(container).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>
);
