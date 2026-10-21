import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, ApiError } from "../packages/client/src/index.ts";
import { buildApp, configFrom } from "../server/index.ts";

afterEach(() => vi.restoreAllMocks());

it.each([500, 502, 503, 504, 408])(
  "retries HTTP %i with the same UUID, body and current CSRF",
  async (status) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "upstream_error", message: "Unavailable" } },
          { status },
        ),
      )
      .mockResolvedValueOnce(Response.json({ runId: "accepted" }));
    const client = new Client();
    client.csrf = "before";
    const body = { action: { context: { id: "original" } } };
    await expect(client.command("/v1/probe", body)).rejects.toMatchObject({
      status,
    });
    const pending = client.pending;
    expect(pending?.body.commandId).toMatch(/^[0-9a-f-]{36}$/);
    body.action.context.id = "changed outside client";
    client.csrf = "refreshed";
    await expect(client.command("/v1/other", {})).rejects.toThrow(
      "Сначала повторите",
    );
    expect(await client.retry()).toEqual({ runId: "accepted" });
    expect(fetch.mock.calls[1][0]).toBe(fetch.mock.calls[0][0]);
    expect(fetch.mock.calls[1][1]?.body).toBe(fetch.mock.calls[0][1]?.body);
    expect(
      JSON.parse(fetch.mock.calls[1][1]!.body as string).action.context.id,
    ).toBe("original");
    expect(fetch.mock.calls[1][1]?.headers).toMatchObject({
      "x-csrf-token": "refreshed",
    });
    expect(client.pending).toBeUndefined();
  },
);

it.each(["network", "html-502", "invalid-200"])(
  "keeps the command after an ambiguous %s response",
  async (scenario) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    if (scenario === "network")
      fetch.mockRejectedValueOnce(new TypeError("Connection lost"));
    else
      fetch.mockResolvedValueOnce(
        new Response("<html>proxy</html>", {
          status: scenario === "html-502" ? 502 : 200,
        }),
      );
    fetch.mockResolvedValueOnce(Response.json({ ok: true }));
    const client = new Client();
    await expect(client.create()).rejects.toThrow();
    expect(client.pending).toBeDefined();
    await client.retry();
    expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
    expect(client.pending).toBeUndefined();
  },
);

it.each([400, 401, 403, 409, 410, 429])(
  "clears definitive HTTP %i failures",
  async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json(
        { error: { code: "rejected", message: "Rejected" } },
        { status },
      ),
    );
    const client = new Client();
    await expect(client.create()).rejects.toBeInstanceOf(ApiError);
    expect(client.pending).toBeUndefined();
  },
);

it("does not let a late concurrent retry clear a newer pending command", async () => {
  let late!: (value: Response) => void;
  vi.spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new Error("lost"))
    .mockResolvedValueOnce(Response.json({ ok: true }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    )
    .mockResolvedValueOnce(
      Response.json({ error: { code: "upstream" } }, { status: 503 }),
    );
  const client = new Client();
  await expect(client.create()).rejects.toThrow("lost");
  const first = client.retry();
  const second = expect(client.retry()).rejects.toMatchObject({ status: 409 });
  await first;
  await expect(client.command("/v1/new", {})).rejects.toMatchObject({
    status: 503,
  });
  const current = client.pending;
  late(Response.json({ error: { code: "old_conflict" } }, { status: 409 }));
  await second;
  expect(client.pending).toBe(current);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "replay after a committed command loses its response",
  () => {
    it("returns the original dialog through HTTP and creates no duplicate", async () => {
      const owner = `client-${randomUUID()}`;
      const { app, store } = await buildApp(
        configFrom({
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          AUTH_MODE: "custom",
        }),
        {
          startEngine: false,
          auth: {
            resolve: () => ({
              userId: owner,
              name: "Owner",
              csrf: "csrf",
              expiresAt: new Date(Date.now() + 60000),
            }),
          },
          adapter: {
            kind: "agent",
            async run() {
              throw Error("No model");
            },
          },
        },
      );
      try {
        await store.migrate();
        let first = true;
        let original: unknown;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (path, init) => {
          const result = await app.inject({
            method: "POST",
            url: String(path),
            headers: {
              origin: "http://localhost:3100",
              ...Object.fromEntries(new Headers(init!.headers).entries()),
            },
            payload: JSON.parse(init!.body as string),
          });
          expect(result.statusCode).toBe(201);
          if (first) {
            first = false;
            original = result.json();
            return Response.json(
              { error: { code: "bad_gateway" } },
              { status: 502 },
            );
          }
          return Response.json(result.json(), { status: result.statusCode });
        });
        const client = new Client();
        client.csrf = "csrf";
        await expect(client.create()).rejects.toMatchObject({ status: 502 });
        expect(await client.retry()).toEqual(original);
        expect(await store.list(owner)).toHaveLength(1);
      } finally {
        await app.close();
        await store.close();
      }
    });
  },
);
