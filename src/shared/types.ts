/**
 * Shared DTO types between the Fastify API and the React dashboard.
 * These are wire-contract types; the server validates incoming payloads with
 * Zod at every route boundary regardless of these types.
 */

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

export type ProtocolCategoryId = "xray_proxy" | "proxy" | "vpn" | "integration";
export type DeploymentMode = "external" | "internal" | "unknown";
export type SubscriptionFormat = "xray_uri" | "raw_uri" | "singbox_json";
export type EnforcementHint = "unavailable" | "external" | "runtime";

export interface ProtocolInfoDTO {
  id: string;
  displayName: string;
  category: ProtocolCategoryId;
  deploymentMode: DeploymentMode;
  requiresInboundTcp: boolean;
  requiresUdp: boolean;
  requiresRoot: boolean;
  docsUrl: string | null;
  configurationCount?: number;
}

export interface IntegrationFormatDTO {
  id: string;
  name: string;
  description: string;
  docsUrl: string;
  runtimeNote: string;
}

export interface ProtocolCatalogItemDTO extends ProtocolInfoDTO {
  description: string;
  configurationFields: string[];
  externalRuntimeNote: string;
  configurationCount: number;
  status: ProtocolStatusDTO | null;
}

export interface ProtocolCatalogResponse {
  protocols: ProtocolCatalogItemDTO[];
  integrationFormats: IntegrationFormatDTO[];
}

export interface CapabilityCheckDTO {
  key: string;
  label: string;
  available: boolean;
  reason: string;
  evidence?: string;
  checkedAt: string;
}

export interface ProtocolStatusDTO {
  protocolId: string;
  displayName: string;
  state: RuntimeState;
  explanation: string;
  lastHealthCheck: {
    state: RuntimeState;
    outcome: string;
    recordedAt: string | null;
    latencyMs: number | null;
    detail: Record<string, unknown>;
  } | null;
  configurationCount: number;
  enforcementNote: string;
}

export interface ClientDTO {
  id: string;
  label: string;
  email: string | null;
  notes: string | null;
  tags: string[];
  isDisabled: boolean;
  expiresAt: string | null;
  isExpired?: boolean;
  trafficQuotaBytes: string | null;
  trafficEnforcement: EnforcementHint;
  maxConnections: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  protocolIds?: string[];
  subscriptionCount?: number;
  limitEnforcement?: {
    expiry: "panel" | "none";
    trafficQuota: EnforcementHint;
    maxConnections: "unavailable" | "runtime";
  };
}

export interface ClientAssignmentDTO {
  credentialId: string;
  configurationId: string;
  configurationName: string;
  protocolId: string;
  protocolName: string;
  kind: string;
  displayData: Record<string, unknown>;
  revokedAt: string | null;
  createdAt: string;
}

export interface ClientDetailDTO extends ClientDTO {
  assignments: ClientAssignmentDTO[];
}

export interface ConfigurationDTO {
  id: string;
  protocolId: string;
  protocolName: string;
  name: string;
  schemaVersion: string;
  config: Record<string, unknown>;
  isActive: boolean;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  currentVersion: number;
}

export interface ConfigurationVersionDTO {
  id: string;
  configurationId: string;
  versionNumber: number;
  config: Record<string, unknown>;
  schemaVersion: string;
  changeNote: string | null;
  source: string;
  createdBy: string | null;
  createdAt: string | null;
}

export interface SubscriptionDTO {
  id: string;
  clientId: string;
  clientLabel: string;
  name: string;
  format: SubscriptionFormat;
  url: string | null;
  tokenHint: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  lastAccessAt: string | null;
  tokenRotatedAt?: string | null;
  accessCount: number;
}

export interface AuditEventDTO {
  id: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string;
  targetId: string;
  meta: Record<string, unknown>;
  ip: string | null;
  createdAt: string | null;
}

export interface DashboardStatsDTO {
  totalClients: number;
  activeClients: number;
  disabledClients: number;
  expiredClients: number;
  expiringWithinDays: {
    clients: number;
    windowDays: number;
  };
  configuredProtocols: number;
  verifiedRunningProtocols: number;
  runtimeNote: string;
  activeSubscriptions: number;
  recentEvents: AuditEventDTO[];
}

export interface DiagnosticReportDTO {
  nodeVersion: string;
  platform: string;
  arch: string;
  processUser: string;
  isContainer?: boolean | null;
  cwdWritable?: boolean;
  homeDirWritable?: boolean | null;
  databaseReachable: boolean;
  migrationsApplied?: boolean;
  allMigrationsApplied: boolean;
  runtimeListenersEnabled?: boolean;
  deploymentModel?: string;
  checksSummary: {
    total: number;
    available: number;
    unavailable: number;
  };
  checks: CapabilityCheckDTO[];
  protocols: ProtocolStatusDTO[];
  supportedProtocols?: string[];
  generatedAt: string;
  compatibilityReview?: {
    reviewedAt: string;
    sources: string[];
  };
}

export interface AdminUserDTO {
  id: string;
  username: string;
  role: "admin" | "operator" | "viewer";
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AppSettingsDTO {
  uiDefaultLanguage: "en" | "fa";
  uiDefaultTheme: "dark" | "light";
  subscriptionDefaultFormat: SubscriptionFormat;
  subscriptionMaxPerClient: number;
  installationComplete: boolean;
}

export interface SettingsResponse {
  settings: AppSettingsDTO;
  runtime: {
    publicUrl: string;
    runtimeListenersEnabled: boolean;
    nodeEnv: string;
    nodeVersion: string;
  };
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}
