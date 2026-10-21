import type { Catalog, ComponentApi } from "@a2ui/web_core/catalog";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { compileComponentSchemas } from "../catalog/index.ts";
import type { ComponentCatalog } from "../catalog/index.ts";
import { CatalogRegistry } from "../packages/catalogs/src/index.ts";
import type { CatalogSnapshot } from "../packages/catalogs/src/index.ts";
import { CATALOG_ID, PROFILE } from "../packages/contracts/src/index.ts";
import { AppError } from "../packages/core/src/errors.ts";

export type CatalogProfile = {
  snapshot: CatalogSnapshot;
  model: Catalog<ComponentApi>;
};

export async function createCatalogProfile(
  document: ComponentCatalog,
  model: Catalog<ComponentApi>,
): Promise<CatalogProfile> {
  if (
    typeof document.profile !== "string" ||
    !document.profile.trim() ||
    typeof document.version !== "string" ||
    !document.version.trim()
  )
    throw new Error("Каталогу нужны version и profile");
  if (document.functions && Object.keys(document.functions).length)
    throw new Error("Функции каталога пока не поддерживаются");
  compileComponentSchemas(document, model);
  const registry = new CatalogRegistry();
  registry.register({ name: "project", load: async () => document });
  return { snapshot: await registry.get("project"), model };
}

export function catalogModel(
  snapshot: CatalogSnapshot,
  profiles: readonly CatalogProfile[] = [],
) {
  const profile = profiles.find(
    (entry) =>
      entry.snapshot.id === snapshot.id &&
      entry.snapshot.profile === snapshot.profile,
  );
  if (profile) return profile.model;
  if (snapshot.id === CATALOG_ID && snapshot.profile === PROFILE)
    return basicCatalog;
  throw new AppError(
    422,
    "unsupported_catalog",
    "Для сохранённого каталога не зарегистрирована серверная модель.",
  );
}
