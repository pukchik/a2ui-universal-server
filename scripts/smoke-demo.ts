import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const base = process.env.SMOKE_URL;
if (!base?.endsWith("/"))
  throw new Error("Set SMOKE_URL with a trailing slash");
const origin = process.env.SMOKE_ORIGIN ?? new URL(base).origin;
let cookie = "";
let csrf = "";
async function request(path: string, body?: unknown) {
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body
        ? { origin, "content-type": "application/json", "x-csrf-token": csrf }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return response;
}
const health = await (await request("health")).json();
assert.equal(health.revision, process.env.EXPECTED_SHA);
const html = await (await request("")).text();
assert.ok(html.includes("<uniserver-app>"));
const assets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map(
  (match) => match[1],
);
assert.ok(assets.length >= 2);
for (const asset of assets) {
  const assetUrl: URL = new URL(asset, base);
  assert.equal(assetUrl.origin, new URL(base).origin);
  assert.ok(assetUrl.pathname.startsWith(new URL(base).pathname));
  const response = await fetch(assetUrl, {
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok);
  assert.ok(
    !(response.headers.get("content-type") ?? "").includes("text/html"),
  );
}
await request("auth/demo", {});
const session = await (await request("v1/session")).json();
assert.equal(session.adapter, "fixture");
assert.equal(session.publicDemo, true);
csrf = session.csrf;
const { dialogId } = await (
  await request("v1/dialogs", { commandId: randomUUID() })
).json();
await request(`v1/dialogs/${dialogId}/messages`, {
  commandId: randomUUID(),
  text: "Покажи компактные лампы",
});
async function completed() {
  for (let i = 0; i < 100; i++) {
    const snapshot = await (
      await request(`v1/dialogs/${dialogId}/snapshot`)
    ).json();
    const status = snapshot.dialog.run?.status;
    if (status === "failed" || status === "cancelled")
      throw new Error(`Demo run: ${status}`);
    if (status === "succeeded") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Demo run timeout");
}
const first = await completed();
assert.ok(first.dialog.ui.messages.length > 0);
await request(`v1/dialogs/${dialogId}/actions`, {
  commandId: randomUUID(),
  uiRevision: first.dialog.ui.revision,
  action: {
    surfaceId: "products",
    componentId: "search-button",
    name: "search_products",
    context: { query: "Мини" },
  },
});
const second = await completed();
assert.ok(second.dialog.ui.revision > first.dialog.ui.revision);
assert.ok(JSON.stringify(second.dialog.ui.messages).includes("Мини"));
console.log(
  JSON.stringify({
    revision: health.revision,
    assets: assets.length,
    dialogId,
    action: "search_products",
    status: "succeeded",
  }),
);
