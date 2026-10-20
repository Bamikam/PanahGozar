import { z } from "zod";
import { isIP } from "node:net";

/**
 * Shared Zod primitives for protocol configuration schemas.
 * All port/host inputs are strictly bounded. No templating or shell
 * interpolation ever happens with these values.
 */

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;

function validHost(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  if (/[\s/\\@?#]/.test(value)) return false;
  // Dotted-quad-looking input must be a real IPv4 address, not a numeric hostname
  // such as 999.999.999.999.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return isIP(value) === 4;
  return isIP(value) !== 0 || HOSTNAME_RE.test(value);
}

const HostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(validHost, "must be a valid hostname or IP literal");

export const HostSchema = HostnameSchema;

export const PortSchema = z.coerce.number().int().min(1).max(65535);

export const UuidSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    "must be a UUID"
  );

export const PasswordSchema = z.string().min(8).max(128);

export const PathSchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_\-./]*$/, "only letters, digits, dot, dash, underscore, slash");

export const SniSchema = z
  .string()
  .trim()
  .max(253)
  .refine((value) => HOSTNAME_RE.test(value), "invalid SNI hostname");

/** Bracket IPv6 literals when composing URI authorities / endpoints. */
export function formatHostForAuthority(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export const transportObject = z.object({
  network: z.enum(["tcp", "ws", "grpc"]).default("tcp"),
  path: PathSchema.optional(),
  host: HostSchema.optional(),
  serviceName: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_.\-/]*$/, "invalid gRPC service name")
    .optional(),
  security: z.enum(["none", "tls"]).default("none"),
  tlsSni: SniSchema.optional(),
  tlsAllowInsecure: z.boolean().default(false),
  certificateFile: z
    .string()
    .max(300)
    .regex(/^[A-Za-z0-9_\-./:\\]+$/, "invalid certificate file path")
    .optional(),
  keyFile: z
    .string()
    .max(300)
    .regex(/^[A-Za-z0-9_\-./:\\]+$/, "invalid private key file path")
    .optional(),
});

export type TransportInput = z.infer<typeof transportObject>;

/** Strict JSON envelope guard for imports (limits: 1MB, 32 depth). */
export function parseSafeJson(
  input: unknown
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof input !== "string") {
    // Already an object (e.g. Fastify parsed JSON body)
    if (input != null && typeof input === "object") return { ok: true, value: input };
    return { ok: false, error: "expected JSON text or object" };
  }
  if (input.length > 1_000_000) return { ok: false, error: "payload exceeds 1 MB" };
  try {
    const value = JSON.parse(input);
    if (typeof value !== "object" || value === null)
      return { ok: false, error: "root must be an object" };
    if (jsonDepth(value) > 32) return { ok: false, error: "nesting exceeds 32 levels" };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `invalid JSON: ${e.message}` : "invalid JSON" };
  }
}

function jsonDepth(value: unknown, current = 0): number {
  if (current > 32) return current;
  if (value === null || typeof value !== "object") return current;
  const nest = Object.values(value as Record<string, unknown>);
  if (nest.length === 0) return current + 1;
  return Math.max(...nest.map((n) => jsonDepth(n, current + 1)));
}

export interface ZodValidationIssue {
  path: string;
  message: string;
}

export function zodIssues(error: z.ZodError): ZodValidationIssue[] {
  return error.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
}
