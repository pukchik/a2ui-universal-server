import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog } from "@a2ui/web_core/catalog";
import {
  buildApp,
  configFrom,
  createCatalogProfile,
  startServer,
} from "../server/index.ts";
import { applyUi } from "../packages/core/src/ui.ts";
import { componentSchemas } from "../catalog/index.ts";
import { defaultCatalog } from "../packages/catalogs/src/index.ts";
import { configuredCatalog } from "../server/catalog-config.ts";
import {
  document,
  modelCatalog,
  statusMessages,
} from "../examples/custom-catalog/model.ts";
import { rendererCatalog } from "../examples/custom-catalog/renderer.ts";

const profile = await createCatalogProfile(document, modelCatalog);
const empty = { revision: 0, messages: [] };
it("accepts a project component with matching JSON, SDK model and renderer", () => {
  expect(
    applyUi(empty, statusMessages("Ready"), document, modelCatalog).revision,
  ).toBe(1);
  expect(rendererCatalog.id).toBe(profile.snapshot.id);
  expect(
    rendererCatalog.components
      .get("StatusBadge")!
      .schema.safeParse({ label: "Ready" }).success,
  ).toBe(true);
  expect(rendererCatalog.components.get("StatusBadge")!.element).toBeDefined();
});
it("rejects mismatched models, malformed properties and unregistered component types", async () => {
  await expect(
    createCatalogProfile({ ...document, profile: " " }, modelCatalog),
  ).rejects.toThrow();
  await expect(
    createCatalogProfile(
      { ...document, functions: { custom: {} } },
      modelCatalog,
    ),
  ).rejects.toThrow();
  await expect(
    createCatalogProfile(
      document,
      new Catalog("https://other.invalid/", "0.9", []),
    ),
  ).rejects.toThrow();
  expect(() =>
    componentSchemas(document, new Catalog(document.catalogId, "0.9", [])),
  ).toThrow();
  const invalid = statusMessages("Ready");
  (
    invalid[1].updateComponents!.components[0] as Record<string, unknown>
  ).label = 42;
  expect(() => applyUi(empty, invalid, document, modelCatalog)).toThrow();
  expect(() => applyUi(empty, statusMessages("Ready"))).toThrow();
});
it("loads a registered custom profile from the operator's local source", async () => {
  const folder = await mkdtemp(join(tmpdir(), "a2ui-profile-"));
  const catalogPath = join(folder, "catalog.json");
  const sourcePath = join(folder, "source.json");
  await writeFile(catalogPath, JSON.stringify(document));
  await writeFile(
    sourcePath,
    JSON.stringify({ name: "custom", type: "local", path: catalogPath }),
  );
  expect((await configuredCatalog(sourcePath, [profile])).id).toBe(
    document.catalogId,
  );
  await expect(configuredCatalog(sourcePath)).rejects.toThrow();
});

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)("pinned project profiles", () => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  const config = configFrom({
    DATABASE_URL: database ?? "postgres://unused/unused",
    AUTH_MODE: "custom",
  });
  const adapter = {
    kind: "agent" as const,
    async run() {
      return { text: "", a2uiJson: "[]" };
    },
  };
  const auth = {
    resolve: () => ({
      userId: "profile-owner",
      name: "Owner",
      csrf: "csrf",
      expiresAt: new Date(Date.now() + 60000),
    }),
  };
  beforeAll(async () => {
    built = await buildApp(config, {
      adapter,
      auth,
      catalogs: [profile],
      startEngine: false,
    });
    await built.store.migrate();
  });
  afterAll(async () => {
    await built.app.close();
    await built.store.close();
  });
  it("uses saved profile metadata and models after changing the default", async () => {
    const store = built.store;
    const { dialogId } = (await store.create(
      "profile-owner",
      randomUUID(),
    )) as { dialogId: string };
    await store.accept("profile-owner", dialogId, randomUUID(), {
      text: "Ready",
    });
    const run = (await store.claim())!;
    await store.complete(run, "Ready", statusMessages("Ready"));
    const first = (
      await built.app.inject(`/v1/dialogs/${dialogId}/snapshot`)
    ).json();
    expect(first.catalogId).toBe(document.catalogId);
    expect(first.profile).toBe(document.profile);
    store.catalog = await defaultCatalog();
    const restored = (
      await built.app.inject(`/v1/dialogs/${dialogId}/snapshot`)
    ).json();
    expect(restored.profile).toBe(document.profile);
    expect(restored.dialog.ui).toEqual(first.dialog.ui);
    await store.accept("profile-owner", dialogId, randomUUID(), {
      text: "Again",
    });
    const next = (await store.claim())!;
    store.catalogProfiles = [];
    await expect(store.complete(next, "", [])).rejects.toMatchObject({
      code: "unsupported_catalog",
    });
    await store.fail(next, "test", "Done");
    expect((await store.get(dialogId, "profile-owner")).ui).toEqual(
      first.dialog.ui,
    );
    store.catalogProfiles = [profile];
  });
  it("rejects ambiguous profile registration before starting a listener", async () => {
    await expect(
      startServer(config, {
        adapter,
        auth,
        catalogs: [profile, profile],
        handleSignals: false,
      }),
    ).rejects.toThrow("Повторяющийся");
  });
});
