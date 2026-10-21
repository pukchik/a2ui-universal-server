import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { buildApp, configFrom } from "../server/index.ts";
import { api, swaggerRequest } from "../server/openapi.ts";

let server: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  server = await buildApp(
    configFrom({ DATABASE_URL: "postgres://unused/unused", AUTH_MODE: "demo" }),
    {
      startEngine: false,
      adapter: {
        kind: "agent",
        async run() {
          throw Error("No agent in schema tests");
        },
      },
    },
  );
  await server.app.ready();
});
afterAll(async () => {
  await server.app.close();
  await server.store.close();
});

it("documents every public operation, response, security requirement and resolvable model", async () => {
  const response = await server.app.inject("/openapi.json");
  expect(response.statusCode).toBe(200);
  const spec = response.json();
  expect(spec.openapi).toBe("3.0.3");
  expect(spec.components.schemas.Dialog.properties.run.nullable).toBe(true);
  expect(JSON.stringify(spec)).not.toContain('"type":"null"');
  const operations = Object.values(spec.paths).flatMap((path: any) =>
    Object.values(path),
  ) as any[];
  expect(operations.map((operation) => operation.operationId).sort()).toEqual(
    Object.values(api)
      .map((schema) => schema.operationId)
      .sort(),
  );
  expect(
    new Set(operations.map((operation) => operation.operationId)).size,
  ).toBe(operations.length);
  for (const operation of operations) {
    expect(operation.summary).toBeTruthy();
    expect(operation.description).toBeTruthy();
    expect(operation.tags).toHaveLength(1);
    expect(operation.security).toBeDefined();
    expect(
      Object.keys(operation.responses).some((code) => /^[23]/.test(code)),
    ).toBe(true);
    for (const result of Object.values(operation.responses) as any[])
      expect(result.description).toBeTruthy();
  }
  const post = spec.paths["/v1/dialogs/{id}/messages"].post;
  expect(post.security).toEqual([{ sessionCookie: [], csrfToken: [] }]);
  expect(post.requestBody.content["application/json"].schema.required).toEqual([
    "commandId",
    "text",
  ]);
  expect(post.responses[429].content["application/json"].schema.$ref).toContain(
    "ApiError",
  );
  expect(spec.paths["/health"].get.security).toEqual([]);
  expect(
    spec.paths["/auth/login"].get.responses[302].headers.location,
  ).toBeDefined();
  expect(
    spec.paths["/v1/dialogs/{id}/events"].get.responses[200].content[
      "text/event-stream"
    ],
  ).toBeDefined();
  expect(
    spec.paths["/v1/dialogs/{id}/events"].get.parameters.map(
      (p: any) => p.name,
    ),
  ).toEqual(expect.arrayContaining(["id", "after", "last-event-id"]));
  expect(
    spec.paths["/v1/dialogs/{id}/runs/{runId}/cancel"].post.parameters
      .filter((p: any) => p.in === "path")
      .every((p: any) => p.required),
  ).toBe(true);
  expect(
    Object.keys(spec.paths).some(
      (path) =>
        path.startsWith("/docs") ||
        path.startsWith("/internal") ||
        path === "/openapi.json",
    ),
  ).toBe(false);
  // Catch broken references throughout requests, responses and nested schemas.
  for (const match of JSON.stringify(spec).matchAll(/"\$ref":"([^" ]+)"/g)) {
    expect(match[1]).toMatch(/^#\//);
    const value = match[1]
      .slice(2)
      .split("/")
      .reduce(
        (node: any, part) =>
          node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")],
        spec,
      );
    expect(value, match[1]).toBeDefined();
  }
});

it("serves Swagger UI and its assets locally with the same generated specification", async () => {
  const html = await server.app.inject("/docs/");
  expect(html.statusCode).toBe(200);
  expect(html.headers["content-type"]).toContain("text/html");
  expect(html.headers["content-security-policy"]).toBeTruthy();
  expect(html.body).toContain("swagger-ui");
  for (const file of [
    "swagger-ui.css",
    "swagger-ui-bundle.js",
    "swagger-initializer.js",
  ]) {
    const result = await server.app.inject(`/docs/static/${file}`);
    expect(result.statusCode, file).toBe(200);
    expect(result.headers["content-type"]).not.toContain("text/html");
  }
  expect((await server.app.inject("/docs/json")).json()).toEqual(
    (await server.app.inject("/openapi.json")).json(),
  );
  const initializer = await server.app.inject(
    "/docs/static/swagger-initializer.js",
  );
  expect(initializer.body).toContain("X-CSRF-Token");
  expect(initializer.body).toContain("/v1/session");
});

it("derives new operations from registered route schemas without a separate specification file", async () => {
  const extra = await buildApp(
    configFrom({ DATABASE_URL: "postgres://unused/unused", AUTH_MODE: "demo" }),
    {
      startEngine: false,
      adapter: {
        kind: "agent",
        async run() {
          throw Error("No agent");
        },
      },
    },
  );
  try {
    extra.app.post(
      "/v1/probe",
      {
        schema: {
          operationId: "probe",
          summary: "Schema probe",
          description: "Test route",
          tags: ["service"],
          security: [],
          body: Type.Object(
            { value: Type.Integer() },
            { additionalProperties: false },
          ),
          response: { 200: Type.Object({ value: Type.Integer() }) },
        },
      },
      async (request) => request.body,
    );
    const spec = (await extra.app.inject("/openapi.json")).json();
    expect(
      spec.paths["/v1/probe"].post.requestBody.content["application/json"]
        .schema.properties.value.type,
    ).toBe("integer");
    expect(
      (
        await extra.app.inject({
          method: "POST",
          url: "/v1/probe",
          payload: { value: "invalid" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await extra.app.inject({
          method: "POST",
          url: "/v1/probe",
          payload: { value: 42 },
        })
      ).json(),
    ).toEqual({ value: 42 });
  } finally {
    await extra.app.close();
    await extra.store.close();
  }
});

it("loads the spec without a method and attaches current CSRF only to same-origin commands", async () => {
  vi.stubGlobal("window", {
    location: {
      href: "http://localhost:3100/docs/",
      origin: "http://localhost:3100",
    },
  });
  const lookup = vi.fn(async () =>
    Response.json({ authenticated: true, csrf: "fresh-token" }),
  );
  vi.stubGlobal("fetch", lookup);
  try {
    await swaggerRequest({ url: "/docs/json" });
    await swaggerRequest({ url: "/v1/session", method: "GET" });
    expect(lookup).not.toHaveBeenCalled();
    expect(
      await swaggerRequest({ url: "/v1/dialogs", method: "POST" }),
    ).toMatchObject({
      credentials: "same-origin",
      headers: { "X-CSRF-Token": "fresh-token" },
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("/v1/session", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const foreign = { url: "https://external.invalid/", method: "POST" };
    expect(await swaggerRequest(foreign)).toEqual(foreign);
    expect(lookup).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
