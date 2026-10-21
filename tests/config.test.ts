import { it, expect } from "vitest";
import { configFrom } from "../apps/server/src/config.ts";
const base = {
  DATABASE_URL: "postgres://localhost/demo",
  AUTH_MODE: "demo",
  ADAPTER: "fixture",
};
it("keeps ordinary demo login on loopback", () => {
  expect(() =>
    configFrom({
      ...base,
      HOST: "0.0.0.0",
      PUBLIC_URL: "https://example.test/test/demo/",
    }),
  ).toThrow();
});
it("allows an explicit remote fixture demo but never a remote Codex demo", () => {
  const env = {
    ...base,
    HOST: "0.0.0.0",
    PUBLIC_DEMO: "true",
    PUBLIC_URL: "https://example.test/test/demo/",
  };
  expect(configFrom(env).PUBLIC_DEMO).toBe("true");
  expect(() =>
    configFrom({ ...env, ADAPTER: "codex", CODEX_PROFILE_DIR: "/tmp/profile" }),
  ).toThrow();
  expect(() =>
    configFrom({ ...env, PUBLIC_URL: "http://example.test/test/demo/" }),
  ).toThrow();
});
it("rejects ambiguous public base paths", () => {
  expect(() =>
    configFrom({ ...base, PUBLIC_URL: "http://localhost:3100/demo" }),
  ).toThrow();
});
