/**
 * Protocol adapter contract (spec §5, adapted to real requirements).
 *
 * Every adapter is honest about capabilities: a valid configuration never
 * implies a reachable service, and runtime status is earned, never assumed.
 */
import type { PrismaClient } from "@prisma/client";

export type RuntimeState =
  | "not_configured"
  | "configured"
  | "runtime_unavailable"
  | "awaiting_verification"
  | "starting"
  | "running_verified"
  | "degraded"
  | "stopped"
  | "error";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Normalized, safe config (secrets kept) ready for storage. */
  normalized?: Record<string, unknown>;
}

export interface ProtocolCapabilities {
  canGenerateConfiguration: boolean;
  canGenerateClientUri: boolean;
  canHostInProcess: boolean;
  requiresExternalServer: boolean;
  reason: string;
  checks: { key: string; available: boolean; reason: string }[];
}

export interface ClientConfigInput {
  /** Server host + port as configured by the admin (never derived from runtime). */
  serverHost: string;
  serverPort: number;
  /** Credential values come from the sealed store, never from request input. */
  credential: Record<string, string>;
  /** Transport/settings snapshot from the stored server configuration. */
  settings: Record<string, unknown>;
  /** Display label for the client link. */
  remark: string;
}

export type SubscriptionFormatId = "xray_uri" | "raw_uri" | "singbox_json";

export interface GeneratedConfig {
  /** Human-ready artifact: URI, .conf, .ovpn, or JSON string. */
  content: string;
  /** Machine-readable detail (e.g. the URI itself for QR rendering). */
  uri?: string;
  /** Which subscription formats can carry this config. */
  compatibleSubscriptionFormats: readonly SubscriptionFormatId[];
}

export interface RuntimeStatus {
  state: RuntimeState;
  /** Required when state is not `not_configured`. Always evidence-based. */
  explanation: string;
  evidence?: Record<string, unknown>;
}

export interface ExportResult {
  filename: string;
  contentType: string;
  content: string;
}

/**
 * Credential material supplied only to an authorized server-side export.
 * `secret` is decrypted in-process from the sealed store and must never be
 * logged or returned by list/detail endpoints.
 */
export interface ExportCredential {
  id: string;
  clientId: string;
  clientLabel: string;
  publicData: Record<string, unknown>;
  secret: Record<string, string>;
}

export interface AdapterContext {
  db: PrismaClient;
}

export interface ProtocolAdapter {
  readonly id: string;
  readonly displayName: string;

  detectCapabilities(): Promise<ProtocolCapabilities>;
  validateConfig(config: unknown): Promise<ValidationResult>;

  /** Builds the client-facing artifact (URI or file) from stored, validated data. */
  generateClientConfig(input: ClientConfigInput): Promise<GeneratedConfig>;

  /**
   * Optional sing-box outbound representation. Present only when the adapter
   * can express the protocol as a documented sing-box outbound; this is what
   * makes `singbox_json` subscriptions truthful.
   */
  generateSingboxOutbound?(input: ClientConfigInput): Promise<Record<string, unknown>>;

  /**
   * Honest runtime status. In the reference deployment this returns
   * `runtime_unavailable` with an explanation, because the panel does not
   * host protocol listeners. It must never claim `running_verified`
   * without a real, recorded, passing health check.
   */
  getRuntimeStatus(): Promise<RuntimeStatus>;

  /** Produces the server-side configuration artifact for export. */
  exportConfig(
    config: Record<string, unknown>,
    schemaVersion: string,
    credentials?: readonly ExportCredential[]
  ): ExportResult;

  /** Subscription-format compatibility filter. */
  supportedSubscriptionFormats(): readonly SubscriptionFormatId[];
}
