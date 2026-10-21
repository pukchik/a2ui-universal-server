import { z } from "zod";
export const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  PUBLIC_URL: z.string().url().default("http://localhost:3100"),
  DATABASE_URL: z.string().min(1),
  AUTH_MODE: z.enum(["oidc", "demo"]).default("oidc"),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  CATALOG_SOURCE_CONFIG: z.string().optional(),
  PROJECT_INSTRUCTIONS_FILE: z.string().optional(),
  ADAPTER: z.enum(["codex", "fixture"]).default("codex"),
  CODEX_BIN: z.string().default("codex"),
  CODEX_PROFILE_DIR: z.string().optional(),
  CODEX_MODEL: z.string().optional(),
  RUN_TIMEOUT_MS: z.coerce.number().int().min(100).max(600000).default(120000),
  MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(8).default(2),
});
export type Config = z.infer<typeof envSchema>;
export function configFrom(env: NodeJS.ProcessEnv): Config {
  const config = envSchema.parse(env);
  const url = new URL(config.PUBLIC_URL);
  if (
    config.AUTH_MODE === "demo" &&
    (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
      !["127.0.0.1", "localhost", "::1"].includes(config.HOST))
  )
    throw new Error("Демо-вход разрешён только на loopback");
  if (
    config.AUTH_MODE === "oidc" &&
    (!config.OIDC_ISSUER || !config.OIDC_CLIENT_ID)
  )
    throw new Error("Настройте OIDC_ISSUER и OIDC_CLIENT_ID");
  if (config.ADAPTER === "codex" && !config.CODEX_PROFILE_DIR)
    throw new Error(
      "Укажите отдельный CODEX_PROFILE_DIR для служебной авторизации Codex",
    );
  return config;
}
