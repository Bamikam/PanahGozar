-- CreateEnum
CREATE TYPE "ProtocolCategory" AS ENUM ('xray_proxy', 'proxy', 'vpn', 'integration');

-- CreateEnum
CREATE TYPE "DeploymentMode" AS ENUM ('external', 'internal', 'unknown');

-- CreateEnum
CREATE TYPE "RoleName" AS ENUM ('admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "TrafficEnforcement" AS ENUM ('unavailable', 'external', 'runtime');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('vless_uuid', 'vmess_uuid', 'trojan_password', 'shadowsocks_password', 'socks_username', 'http_username', 'mtproto_secret', 'wireguard_keypair', 'openvpn_credentials');

-- CreateEnum
CREATE TYPE "SubscriptionFormat" AS ENUM ('xray_uri', 'raw_uri', 'singbox_json');

-- CreateEnum
CREATE TYPE "RuntimeState" AS ENUM ('not_configured', 'configured', 'runtime_unavailable', 'awaiting_verification', 'starting', 'running_verified', 'degraded', 'stopped', 'error');

-- CreateTable
CREATE TABLE "protocols" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "category" "ProtocolCategory" NOT NULL,
    "deploymentMode" "DeploymentMode" NOT NULL DEFAULT 'unknown',
    "schemaVersion" TEXT NOT NULL DEFAULT '1',
    "requiresInboundTcp" BOOLEAN NOT NULL DEFAULT true,
    "requiresUdp" BOOLEAN NOT NULL DEFAULT false,
    "requiresRoot" BOOLEAN NOT NULL DEFAULT false,
    "docsUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protocols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" "RoleName" NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "notes" TEXT,
    "tags" TEXT[],
    "email" VARCHAR(160),
    "isDisabled" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "trafficQuotaBytes" BIGINT,
    "trafficEnforcement" "TrafficEnforcement" NOT NULL DEFAULT 'unavailable',
    "maxConnections" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_references" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "configurationId" TEXT,
    "kind" "CredentialKind" NOT NULL,
    "displayData" JSONB NOT NULL DEFAULT '{}',
    "sealedSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "credential_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protocol_configurations" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT '1',
    "config" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "protocol_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuration_versions" (
    "id" TEXT NOT NULL,
    "configurationId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "changeNote" VARCHAR(500),
    "source" TEXT NOT NULL DEFAULT 'panel',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "configuration_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "application_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "format" "SubscriptionFormat" NOT NULL DEFAULT 'xray_uri',
    "tokenHash" TEXT NOT NULL,
    "tokenHint" VARCHAR(12) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "lastAccessAt" TIMESTAMP(3),
    "tokenRotatedAt" TIMESTAMP(3),
    "accessCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_capabilities" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "protocolId" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runtime_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_health_checks" (
    "id" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "configurationId" TEXT,
    "state" "RuntimeState" NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'skipped',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "latencyMs" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "runtime_health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "action" VARCHAR(120) NOT NULL,
    "targetType" VARCHAR(64) NOT NULL,
    "targetId" VARCHAR(64) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "protocols_displayName_key" ON "protocols"("displayName");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE INDEX "admin_users_roleId_idx" ON "admin_users"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "clients_isDisabled_idx" ON "clients"("isDisabled");

-- CreateIndex
CREATE INDEX "clients_label_idx" ON "clients"("label");

-- CreateIndex
CREATE INDEX "clients_expiresAt_idx" ON "clients"("expiresAt");

-- CreateIndex
CREATE INDEX "credential_references_clientId_idx" ON "credential_references"("clientId");

-- CreateIndex
CREATE INDEX "credential_references_configurationId_idx" ON "credential_references"("configurationId");

-- CreateIndex
CREATE INDEX "credential_references_protocolId_idx" ON "credential_references"("protocolId");

-- CreateIndex
CREATE INDEX "credential_references_clientId_configurationId_idx" ON "credential_references"("clientId", "configurationId");

-- CreateIndex
CREATE INDEX "protocol_configurations_protocolId_idx" ON "protocol_configurations"("protocolId");

-- CreateIndex
CREATE INDEX "protocol_configurations_isActive_idx" ON "protocol_configurations"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "protocol_configurations_protocolId_name_key" ON "protocol_configurations"("protocolId", "name");

-- CreateIndex
CREATE INDEX "configuration_versions_configurationId_idx" ON "configuration_versions"("configurationId");

-- CreateIndex
CREATE UNIQUE INDEX "configuration_versions_configurationId_versionNumber_key" ON "configuration_versions"("configurationId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tokenHash_key" ON "subscriptions"("tokenHash");

-- CreateIndex
CREATE INDEX "subscriptions_clientId_idx" ON "subscriptions"("clientId");

-- CreateIndex
CREATE INDEX "subscriptions_tokenHash_idx" ON "subscriptions"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_capabilities_key_key" ON "runtime_capabilities"("key");

-- CreateIndex
CREATE INDEX "runtime_capabilities_protocolId_idx" ON "runtime_capabilities"("protocolId");

-- CreateIndex
CREATE INDEX "runtime_health_checks_protocolId_idx" ON "runtime_health_checks"("protocolId");

-- CreateIndex
CREATE INDEX "runtime_health_checks_configurationId_idx" ON "runtime_health_checks"("configurationId");

-- CreateIndex
CREATE INDEX "runtime_health_checks_recordedAt_idx" ON "runtime_health_checks"("recordedAt");

-- CreateIndex
CREATE INDEX "audit_events_actorId_idx" ON "audit_events"("actorId");

-- CreateIndex
CREATE INDEX "audit_events_action_idx" ON "audit_events"("action");

-- CreateIndex
CREATE INDEX "audit_events_createdAt_idx" ON "audit_events"("createdAt");

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_references" ADD CONSTRAINT "credential_references_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_references" ADD CONSTRAINT "credential_references_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "protocol_configurations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protocol_configurations" ADD CONSTRAINT "protocol_configurations_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "protocols"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_versions" ADD CONSTRAINT "configuration_versions_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "protocol_configurations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_versions" ADD CONSTRAINT "configuration_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_capabilities" ADD CONSTRAINT "runtime_capabilities_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_health_checks" ADD CONSTRAINT "runtime_health_checks_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
