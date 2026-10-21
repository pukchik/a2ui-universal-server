import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { buildDemoApp as buildApp } from "../demo/server/app.ts";
import { configFrom } from "../demo/server/config.ts";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("HTTP authorization and commands", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let store: Awaited<ReturnType<typeof buildApp>>["store"];
  let cookie = "";
  let csrf = "";
  beforeAll(async () => {
    ({ app, store } = await buildApp(
      configFrom({ DATABASE_URL: url, AUTH_MODE: "demo", ADAPTER: "fixture" }),
      { startEngine: false },
    ));
    await store.migrate();
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/demo",
      headers: { origin: "http://localhost:3100" },
    });
    cookie = String(login.headers["set-cookie"]).split(";")[0];
    const session = await app.inject({
      url: "/v1/session",
      headers: { cookie },
    });
    csrf = session.json().csrf;
  });
  afterAll(async () => {
    await app.close();
    await store.close();
  });
  it("requires login and CSRF for commands", async () => {
    expect((await app.inject("/v1/dialogs")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/dialogs",
          headers: { cookie },
          payload: { commandId: randomUUID() },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("validates UUIDs and does not expose foreign dialogs", async () => {
    expect(
      (await app.inject({ url: "/v1/dialogs/not-uuid", headers: { cookie } }))
        .statusCode,
    ).toBe(400);
    const id = (
      (await store.create("foreign-user", randomUUID())) as { dialogId: string }
    ).dialogId;
    expect(
      (
        await app.inject({
          url: `/v1/dialogs/${id}/snapshot`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("accepts and deduplicates the same HTTP command", async () => {
    const commandId = randomUUID();
    const request = {
      method: "POST" as const,
      url: "/v1/dialogs",
      headers: {
        cookie,
        origin: "http://localhost:3100",
        "x-csrf-token": csrf,
      },
      payload: { commandId },
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual(second.json());
  });
  it("denies unauthenticated MCP calls", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/internal/mcp", payload: {} }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/mcp",
          headers: { authorization: "Bearer fake" },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });
  it("returns a CSRF error for malformed Unicode instead of a server error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/dialogs",
      headers: {
        cookie,
        origin: "http://localhost:3100",
        "x-csrf-token": "я".repeat(csrf.length),
      },
      payload: { commandId: randomUUID() },
    });
    expect(response.statusCode).toBe(403);
  });
  it("publishes the generation and action contracts in OpenAPI", async () => {
    const response = await app.inject("/openapi.json");
    expect(response.statusCode).toBe(200);
    expect(response.json().paths["/v1/generations"].post).toBeDefined();
    expect(
      response.json().paths["/v1/dialogs/{id}/actions"].post,
    ).toBeDefined();
  });
});
