import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Icon } from "./components/ui.js";

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastCtx {
  toast: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const Ctx = createContext<ToastCtx>({ toast: () => {}, success: () => {}, error: () => {} });
let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = nextId++;
    setItems((current) => [...current.slice(-3), { id, message, tone }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 5000);
  }, []);

  const value = useMemo<ToastCtx>(
    () => ({
      toast,
      success: (message) => toast(message, "success"),
      error: (message) => toast(message, "error"),
    }),
    [toast]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:end-5 sm:items-end"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl backdrop-blur ${
              item.tone === "success"
                ? "border-ok/30 bg-surface-raised text-ok"
                : item.tone === "error"
                  ? "border-danger/30 bg-surface-raised text-danger"
                  : "border-accent/30 bg-surface-raised text-ink"
            }`}
            role={item.tone === "error" ? "alert" : "status"}
          >
            <Icon
              name={
                item.tone === "success" ? "check" : item.tone === "error" ? "alert" : "activity"
              }
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span className="text-ink">{item.message}</span>
            <button
              type="button"
              className="ms-auto text-ink-muted hover:text-ink"
              aria-label="Dismiss notification"
              onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  return useContext(Ctx);
}
