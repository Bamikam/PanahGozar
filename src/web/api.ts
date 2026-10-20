import type { ApiError } from "../shared/types.js";

/**
 * Same-origin API client.
 * - Reads the double-submit CSRF token from the JS-readable cookie.
 * - Sends credentials only to this origin.
 * - Emits a session-expired event on authenticated 401 responses.
 * - Never logs request bodies or response payloads (they can contain secrets).
 */
export class ApiErrorImpl extends Error implements ApiError {
  code?: string;
  details?: unknown;
  status: number;
  error: string;
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.error = message;
  }
}

export function readCsrfCookie(): string {
  const match = document.cookie.match(/(?:^|;\s*)pg_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

async function parseError(res: Response): Promise<ApiErrorImpl> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const data = (body ?? {}) as Partial<ApiError> & { message?: string };
  const message =
    typeof data.error === "string"
      ? data.error
      : typeof data.message === "string"
        ? data.message
        : `HTTP ${res.status}`;
  return new ApiErrorImpl(message, res.status, data.code, data.details);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCsrfCookie();
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiErrorImpl("network error", 0, "NETWORK");
  }
  if (!res.ok) {
    const error = await parseError(res);
    if (
      error.status === 401 &&
      !path.startsWith("/api/auth/login") &&
      !path.startsWith("/api/auth/me")
    ) {
      window.dispatchEvent(new CustomEvent("pg:unauthorized"));
    }
    throw error;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiErrorImpl("invalid server response", res.status, "BAD_RESPONSE");
  }
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      return utf8[1];
    }
  }
  const simple = /filename="?([^";]+)"?/i.exec(header);
  return simple?.[1] ?? null;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),

  async postWithHeaders<T>(path: string, body: unknown, extraHeaders: Record<string, string>) {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await parseError(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  },

  async getBlob(path: string): Promise<Blob> {
    const res = await fetch(path, { credentials: "same-origin", headers: { accept: "*/*" } });
    if (!res.ok) throw await parseError(res);
    return res.blob();
  },

  async download(path: string, fallbackName: string): Promise<void> {
    const res = await fetch(path, { credentials: "same-origin", headers: { accept: "*/*" } });
    if (!res.ok) {
      const error = await parseError(res);
      if (error.status === 401) window.dispatchEvent(new CustomEvent("pg:unauthorized"));
      throw error;
    }
    const blob = await res.blob();
    const name = filenameFromDisposition(res.headers.get("content-disposition")) ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  ApiError: ApiErrorImpl,
};

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiErrorImpl) {
    if (error.code === "NETWORK") return "Network error";
    return error.message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export function errorDetails(error: unknown): { path: string; message: string }[] {
  if (!(error instanceof ApiErrorImpl)) return [];
  const details = error.details;
  if (!Array.isArray(details)) return [];
  return details
    .filter(
      (item): item is { path?: unknown; message?: unknown } =>
        typeof item === "object" && item !== null
    )
    .map((item) => ({
      path: typeof item.path === "string" ? item.path : "",
      message: typeof item.message === "string" ? item.message : String(item),
    }));
}
