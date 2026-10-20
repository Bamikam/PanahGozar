/** Application configuration shape. Defined separately to avoid cycles. */
export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  publicUrl: string;
  databaseUrl: string;
  sessionSecret: string;
  encryptionKey: Buffer;
  setupToken: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  enableRuntimeListeners: boolean;
  trustProxy: boolean;
  cookieSecure: boolean;
  isDev: boolean;
}
