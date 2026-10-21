import { it, expect } from "vitest";
import { buildApp, configFrom, startServer } from "../server/index.ts";
import type { AuthSession } from "../server/index.ts";
import { Store } from "../server/storage/store.ts";
import { codexOptionsFrom } from "../server/adapters/codex/index.ts";
const config = configFrom({
  DATABASE_URL: "postgres://unused",
  AUTH_MODE: "custom",
});
const adapter = {
  kind: "agent" as const,
  async run() {
    return { text: "", a2uiJson: "[]" };
  },
};
it.each([
  ["missing", undefined],
  [
    "expired",
    { userId: "alice", name: "Alice", csrf: "csrf", expiresAt: new Date(0) },
  ],
  [
    "invalid expiry",
    { userId: "alice", name: "Alice", csrf: "csrf", expiresAt: new Date(NaN) },
  ],
])("rejects %s host sessions", async (_name, session) => {
  const { app, store } = await buildApp(config, {
    adapter,
    startEngine: false,
    auth: { resolve: () => session },
  });
  try {
    expect((await app.inject("/v1/session")).json().authenticated).toBe(false);
    expect((await app.inject("/v1/dialogs")).statusCode).toBe(401);
  } finally {
    await app.close();
    await store.close();
  }
});
it("rejects malformed identities and does not silently fall back to local sessions", async () => {
  const { app, store } = await buildApp(config, {
    adapter,
    startEngine: false,
    auth: {
      resolve: () => ({
        userId: " ",
        name: "Alice",
        csrf: "csrf",
        expiresAt: new Date(Date.now() + 60000),
      }),
    },
  });
  try {
    expect((await app.inject("/v1/session")).json().error.code).toBe(
      "invalid_auth_session",
    );
  } finally {
    await app.close();
    await store.close();
  }
});
it("requires host login/logout handlers when those operations are requested", async () => {
  const session: AuthSession = {
    userId: "alice",
    name: "Alice",
    csrf: "csrf",
    expiresAt: new Date(Date.now() + 60000),
  };
  const { app, store } = await buildApp(config, {
    adapter,
    startEngine: false,
    auth: { resolve: () => session },
  });
  try {
    expect((await app.inject("/auth/login")).statusCode).toBe(501);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/logout",
          headers: { origin: config.PUBLIC_URL, "x-csrf-token": session.csrf },
        })
      ).statusCode,
    ).toBe(501);
  } finally {
    await app.close();
    await store.close();
  }
});
it("requires an explicit custom provider and closes storage after a startup error", async () => {
  const store = new Store(config.DATABASE_URL);
  let closed = 0;
  const end = store.close.bind(store);
  store.close = async () => {
    closed++;
    await end();
  };
  await expect(
    startServer(config, { adapter, store, handleSignals: false }),
  ).rejects.toThrow("options.auth");
  expect(closed).toBe(1);
});
it("keeps Codex environment validation in the adapter", () => {
  expect(() => codexOptionsFrom({})).toThrow();
  expect(
    codexOptionsFrom({
      CODEX_PROFILE_DIR: "/tmp/service-profile",
      CODEX_RUNTIME_DIR: "/tmp/runtime",
    }),
  ).toMatchObject({
    executable: "codex",
    profileDir: "/tmp/service-profile",
    runtimeDir: "/tmp/runtime",
  });
});
