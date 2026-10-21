import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, configFrom } from "../server/index.ts";
import type { ToolContext, AgentAdapter } from "../server/index.ts";
import { notesOptions } from "../examples/notes/app.ts";
import { Store } from "../server/storage/store.ts";

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)("application integration", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const config = configFrom({
    DATABASE_URL: database ?? "postgres://unused/unused",
    AUTH_MODE: "custom",
  });
  config.PORT = 0;
  let origin: string;
  let alice: { cookie: string; csrf: string };
  let bob: { cookie: string; csrf: string };
  let captured: ToolContext | undefined;
  let entered: (() => void) | undefined;
  const options = notesOptions();
  beforeAll(async () => {
    server = await startServer(config, {
      ...options,
      handleSignals: false,
      tools: {
        ...options.tools,
        identity: {
          description: "Test trusted execution identity",
          schema: z.object({ userId: z.string().optional() }).strict(),
          execute: (_args, context) => {
            captured = context;
            return {
              userId: context.userId,
              dialogId: context.dialogId,
              runId: context.runId,
            };
          },
        },
        wait: {
          description: "Wait until cancellation",
          schema: z.object({}).strict(),
          execute: (_args, context) =>
            new Promise((_resolve, reject) => {
              captured = context;
              context.signal.throwIfAborted();
              context.signal.addEventListener(
                "abort",
                () => reject(context.signal.reason),
                { once: true },
              );
              entered?.();
            }),
        },
      },
    });
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw Error("No listener");
    origin = `http://localhost:${address.port}`;
    config.PUBLIC_URL = origin;
    alice = await login("alice");
    bob = await login("bob");
  });
  afterAll(async () => server?.close());
  async function login(name: string) {
    const response = await fetch(`${origin}/auth/login?user=${name}`);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const session = await (
      await fetch(`${origin}/v1/session`, { headers: { cookie } })
    ).json();
    expect(session.authMode).toBe("custom");
    expect(session.adapter).toBe("notes-fixture");
    return { cookie, csrf: session.csrf as string };
  }
  async function request(path: string, body?: object, identity = alice) {
    return fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: identity.cookie,
        origin,
        "x-csrf-token": identity.csrf,
        "content-type": "application/json",
      },
      body: body
        ? JSON.stringify({ commandId: randomUUID(), ...body })
        : undefined,
    });
  }
  async function create(identity = alice) {
    const response = await request("/v1/dialogs", {}, identity);
    expect(response.status).toBe(201);
    return (await response.json()).dialogId as string;
  }
  async function done(id: string) {
    await expect
      .poll(
        async () =>
          (await (await request(`/v1/dialogs/${id}/snapshot`)).json()).dialog
            .run?.status,
        { timeout: 5000, interval: 20 },
      )
      .toMatch(/succeeded|failed|cancelled/);
    return (await request(`/v1/dialogs/${id}/snapshot`)).json();
  }
  it("uses host sessions, renders only the owner's notes and continues an action", async () => {
    const id = await create();
    expect(
      (await request(`/v1/dialogs/${id}/messages`, { text: "Мои заметки" }))
        .status,
    ).toBe(202);
    const first = await done(id);
    expect(first.dialog.run.status).toBe("succeeded");
    expect(JSON.stringify(first.dialog.ui)).toContain("Заметка Алисы");
    expect(JSON.stringify(first.dialog.ui)).not.toContain("Заметка Боба");
    const action = {
      surfaceId: "notes",
      componentId: "alice-1-button",
      name: "open_note",
      context: { id: "alice-1" },
    };
    expect(
      (await request(`/v1/dialogs/${id}/actions`, { uiRevision: 0, action }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(`/v1/dialogs/${id}/actions`, {
          uiRevision: first.dialog.ui.revision,
          action,
        })
      ).status,
    ).toBe(202);
    const second = await done(id);
    expect(second.dialog.run.status).toBe("succeeded");
    expect(second.dialog.ui.revision).toBe(2);
    expect(JSON.stringify(second.dialog.ui)).toContain("Личная запись Алисы");
    const restored = await (await request(`/v1/dialogs/${id}/snapshot`)).json();
    expect(restored.dialog.ui).toEqual(second.dialog.ui);
    expect(
      (await request(`/v1/dialogs/${id}/snapshot`, undefined, bob)).status,
    ).toBe(404);
    const events = await server.store.events(
      id,
      "notes:alice",
      first.throughSeq,
    );
    expect(events.some((event) => event.type === "ui.updated")).toBe(true);
  });
  it("keeps CSRF and origin checks with custom auth and rejects forged identities", async () => {
    for (const headers of [
      { cookie: alice.cookie, origin },
      {
        cookie: alice.cookie,
        origin: "https://foreign.example",
        "x-csrf-token": alice.csrf,
      },
    ]) {
      const response = await server.app.inject({
        method: "POST",
        url: "/v1/dialogs",
        headers,
        payload: { commandId: randomUUID() },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (
        await server.app.inject({
          url: "/v1/dialogs",
          headers: {
            cookie: "notes_session=notes:bob",
            "x-user-id": "notes:alice",
          },
        })
      ).statusCode,
    ).toBe(401);
    expect((await request("/auth/demo", {})).status).toBe(404);
  });
  it("derives tool identity from the saved run for both direct and MCP calls", async () => {
    const previous = server.engine.adapter;
    const adapter: AgentAdapter = {
      kind: "agent",
      async run(context, call) {
        // Even adapter-controlled context and arguments cannot change the DB owner.
        context.dialog.userId = "notes:bob";
        const direct = await call(
          "identity",
          { userId: "notes:bob" },
          "direct",
        );
        expect(direct).toMatchObject({ userId: "notes:alice" });
        const client = new McpClient({
          name: "integration-test",
          version: "1",
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(context.toolUrl), {
            requestInit: {
              headers: { authorization: `Bearer ${context.token}` },
            },
          }),
        );
        try {
          const reply = await client.callTool({
            name: "identity",
            arguments: { userId: "notes:bob" },
          });
          expect(reply.isError).not.toBe(true);
          expect(JSON.stringify(reply)).toContain("notes:alice");
          expect(JSON.stringify(reply)).not.toContain("notes:bob");
        } finally {
          await client.close();
        }
        await expect(
          call("get_note", { id: "bob-1" }, "foreign"),
        ).rejects.toMatchObject({ code: "note_not_found" });
        return { text: "isolated", a2uiJson: "[]" };
      },
    };
    server.engine.adapter = adapter;
    try {
      const id = await create();
      const accepted = await (
        await request(`/v1/dialogs/${id}/messages`, { text: "identity" })
      ).json();
      expect((await done(id)).dialog.run.status).toBe("succeeded");
      expect(captured).toMatchObject({
        userId: "notes:alice",
        dialogId: id,
        runId: accepted.runId,
      });
      expect(Object.isFrozen(captured)).toBe(true);
    } finally {
      server.engine.adapter = previous;
    }
  });
  it("propagates cancellation into a running tool and refuses late UI", async () => {
    const previous = server.engine.adapter;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    entered = ready;
    server.engine.adapter = {
      kind: "agent",
      async run(_context, call) {
        await call("wait", {}, "wait");
        return { text: "late", a2uiJson: "[]" };
      },
    };
    try {
      const id = await create();
      const accepted = await (
        await request(`/v1/dialogs/${id}/messages`, { text: "wait" })
      ).json();
      await started;
      expect(
        (await request(`/v1/dialogs/${id}/runs/${accepted.runId}/cancel`, {}))
          .status,
      ).toBe(200);
      await expect.poll(() => captured?.signal.aborted).toBe(true);
      const snapshot = await done(id);
      expect(snapshot.dialog.run.status).toBe("cancelled");
      expect(snapshot.dialog.ui.revision).toBe(0);
      await expect.poll(() => server.engine.active.size).toBe(0);
    } finally {
      entered = undefined;
      server.engine.adapter = previous;
    }
  });
  it("refuses a second executor without stopping the first and revokes host sessions", async () => {
    await expect(
      startServer(config, { ...notesOptions(), handleSignals: false }),
    ).rejects.toThrow("Другой экземпляр");
    expect((await fetch(origin + "/health")).status).toBe(200);
    expect((await request("/auth/logout", {})).status).toBe(200);
    expect((await request("/v1/dialogs")).status).toBe(401);
    alice = await login("alice");
  });
  it("releases the executor lock on close and stops on lost lock", async () => {
    await Promise.all([server.close(), server.close()]);
    const store = new Store(database!);
    const acquire = store.acquireLock.bind(store);
    let lost!: () => void;
    store.acquireLock = async (callback) => {
      lost = callback;
      await acquire(callback);
    };
    server = await startServer(config, {
      ...notesOptions(),
      store,
      handleSignals: false,
    });
    lost();
    await expect.poll(() => server.engine.stopping).toBe(true);
    await server.close();
    expect(server.app.server.listening).toBe(false);
  });
});

it("separates core configuration from adapter credentials", () => {
  expect(
    configFrom({ DATABASE_URL: "postgres://test", AUTH_MODE: "custom" }),
  ).not.toHaveProperty("CODEX_PROFILE_DIR");
});
