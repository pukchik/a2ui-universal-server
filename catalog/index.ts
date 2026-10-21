import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject, ValidateFunction } from "ajv";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import manifest from "./catalog.json" with { type: "json" };

export type ComponentCatalog = {
  catalogId: string;
  version: string;
  profile: string;
  components: Record<string, AnySchemaObject>;
  common: AnySchemaObject;
  $defs: Record<string, unknown>;
  [key: string]: unknown;
};

const directory = fileURLToPath(new URL(".", import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

export function loadEditableCatalog(root = directory): ComponentCatalog {
  const config = readJson(join(root, "catalog.json")) as typeof manifest;
  if (
    config.catalogId !== basicCatalog.id ||
    typeof config.version !== "string" ||
    !config.version ||
    typeof config.profile !== "string" ||
    !config.profile ||
    config.$id !== config.catalogId ||
    !Array.isArray(config.components) ||
    !config.components.length ||
    new Set(config.components).size !== config.components.length ||
    config.components.some((name) => !/^[A-Z][A-Za-z0-9]*$/.test(name))
  )
    throw new Error(
      "Проверьте метаданные и список компонентов catalog/catalog.json",
    );
  const files = readdirSync(join(root, "components"))
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (
    JSON.stringify(files) !==
    JSON.stringify(config.components.map((name) => `${name}.json`).sort())
  )
    throw new Error(
      "Список catalog/components/*.json не совпадает с catalog.json",
    );
  const document: ComponentCatalog = {
    ...config,
    $defs: {
      ...config.$defs,
      anyComponent: {
        oneOf: config.components.map((name) => ({
          $ref: `#/components/${name}`,
        })),
      },
      anyFunction: false,
    },
    components: Object.fromEntries(
      config.components.map((name) => [
        name,
        readJson(join(root, "components", `${name}.json`)),
      ]),
    ),
    common: readJson(join(root, "common.json")),
  };
  compileComponentSchemas(document);
  return document;
}

// Schemas come from operator-controlled files or pinned database snapshots.
// No remote schema fetching or coercion of model output is allowed here.
export function compileComponentSchemas(document: ComponentCatalog) {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
  });
  // A2UI stores component schemas in this document-level map.
  ajv.addKeyword({ keyword: "components", schemaType: "object", valid: true });
  ajv.addKeyword({
    keyword: "discriminator",
    schemaType: "object",
    valid: true,
  });
  ajv.addFormat("uri", (value: string) => URL.canParse(value));
  const common = structuredClone(document.common);
  // Older pinned SDK catalogs declared functions, which this profile has always denied.
  if (common.$defs) common.$defs.FunctionCall = false;
  ajv.addSchema(common);
  ajv.addSchema({
    $id: document.catalogId,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: {
      ...document.$defs,
      anyComponent: {
        oneOf: Object.keys(document.components).map((name) => ({
          $ref: `#/components/${name}`,
        })),
      },
      anyFunction: false,
    },
    components: document.components,
  });
  const validators = new Map<string, ValidateFunction>();
  for (const [name, schema] of Object.entries(document.components)) {
    if (!basicCatalog.components.has(name))
      throw new Error(
        `${name}: компонент не реализован текущим Basic renderer`,
      );
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      throw new Error(`${name}: ожидается JSON Schema объекта`);
    if (!ajv.validateSchema(schema))
      throw new Error(`${name}: ${ajv.errorsText()}`);
    try {
      const validate = ajv.getSchema(
        `${document.catalogId}#/components/${name}`,
      );
      if (!validate) throw new Error("Не удалось собрать схему");
      validators.set(name, validate);
    } catch (error) {
      throw new Error(
        `${name}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return validators;
}

export const editableCatalog = loadEditableCatalog();
export const supportedComponents = Object.freeze(
  Object.keys(editableCatalog.components),
);
const compiled = new Map<string, ReturnType<typeof compileComponentSchemas>>();

export function componentSchemas(document: ComponentCatalog = editableCatalog) {
  const key = JSON.stringify(document);
  const cached = compiled.get(key);
  if (cached) return cached;
  const validators = compileComponentSchemas(document);
  if (compiled.size >= 16) compiled.delete(compiled.keys().next().value!);
  compiled.set(key, validators);
  return validators;
}
