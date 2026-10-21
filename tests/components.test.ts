import { readFile, readdir } from "node:fs/promises";
import { it, describe, expect } from "vitest";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { basicCatalog as litCatalog } from "@a2ui/lit/v0_9";
import {
  editableCatalog,
  supportedComponents,
  compileComponentSchemas,
  componentSchemas,
} from "../catalog/index.ts";
import { defaultCatalog } from "../packages/catalogs/src/index.ts";
import { CATALOG_ID } from "../packages/contracts/src/index.ts";
import { applyUi } from "../packages/core/src/ui.ts";
import { preparePrompt } from "../apps/server/src/prompt.ts";
import type { AgentContext } from "../apps/server/src/adapters/types.ts";

const validators = componentSchemas();
const empty = { messages: [], revision: 0 };
const messages = (component: Record<string, unknown>) => [
  {
    version: "v0.9.1",
    createSurface: { surfaceId: "example", catalogId: CATALOG_ID },
  },
  {
    version: "v0.9.1",
    updateComponents: {
      surfaceId: "example",
      components: [
        component,
        ...(component.child ||
        (Array.isArray(component.children) && component.children.length)
          ? [{ id: "label", component: "Text", text: "Лампа для чтения" }]
          : []),
      ],
    },
  },
  {
    version: "v0.9.1",
    updateDataModel: {
      surfaceId: "example",
      value: { title: "Подборка", query: "Мини" },
    },
  },
];

for (const name of supportedComponents) {
  const examples = JSON.parse(
    await readFile(
      new URL(`../catalog/examples/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as { valid: Record<string, unknown>[]; invalid: Record<string, unknown>[] };
  describe(name, () => {
    it("has a compiled schema, SDK model, renderer and positive/negative examples", () => {
      expect(validators.has(name)).toBe(true);
      expect(basicCatalog.components.has(name)).toBe(true);
      expect(litCatalog.components.has(name)).toBe(true);
      expect(examples.valid.length).toBeGreaterThan(0);
      expect(examples.invalid.length).toBeGreaterThan(0);
    });
    examples.valid.forEach((example, index) => {
      it(`accepts valid example ${index + 1} in the local schema, SDK and A2UI surface`, () => {
        expect(example.component).toBe(name);
        const validate = validators.get(name)!;
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
        // SDK component models receive properties; A2UI supplies id/name separately.
        const { id: _id, component: _component, ...properties } = example;
        expect(
          basicCatalog.components.get(name)!.schema.safeParse(properties)
            .success,
        ).toBe(true);
        expect(() => applyUi(empty, messages(example))).not.toThrow();
      });
    });
    examples.invalid.forEach((example, index) => {
      it(`rejects invalid example ${index + 1}`, () => {
        expect(validators.get(name)!(example)).toBe(false);
        expect(() => applyUi(empty, messages(example))).toThrow();
      });
    });
    it("rejects a missing ID, a wrong component name and unknown properties", () => {
      const example = examples.valid[0];
      const { id: _id, ...withoutId } = example;
      expect(validators.get(name)!(withoutId)).toBe(false);
      expect(validators.get(name)!({ ...example, component: "Unknown" })).toBe(
        false,
      );
      expect(
        validators.get(name)!({ ...example, unexpectedProperty: true }),
      ).toBe(false);
    });
  });
}

describe("component catalog contract", () => {
  it("keeps the manifest, component files and examples in sync", async () => {
    const expected = supportedComponents.map((name) => `${name}.json`).sort();
    for (const directory of ["components", "examples"])
      expect(
        (await readdir(new URL(`../catalog/${directory}/`, import.meta.url)))
          .filter((name) => name.endsWith(".json"))
          .sort(),
      ).toEqual(expected);
  });
  it("sends the editable schemas to the agent", async () => {
    const snapshot = await defaultCatalog();
    expect(snapshot.document.components).toEqual(editableCatalog.components);
    const context = {
      catalog: snapshot,
      instructions: "Каталог приложения",
      dialog: { ui: empty },
      history: [],
      run: { input: { text: "Подбери лампу" } },
    } as unknown as AgentContext;
    expect(preparePrompt(context)).toContain(JSON.stringify(snapshot));
  });
  it("rejects malformed schemas and misspelled keywords", () => {
    const malformed = structuredClone(editableCatalog);
    malformed.components.Text = { type: "not-a-json-schema-type" };
    expect(() => compileComponentSchemas(malformed)).toThrow();
    const typo = structuredClone(editableCatalog);
    typo.components.Text.propertiez = {};
    expect(() => compileComponentSchemas(typo)).toThrow(/propertiez/);
  });
  it("rejects unresolved schema references", () => {
    const catalog = structuredClone(editableCatalog);
    catalog.components.Text.allOf[0].$ref = "#/$defs/MissingDefinition";
    expect(() => compileComponentSchemas(catalog)).toThrow(/MissingDefinition/);
  });
  it("rejects components without an implemented model/renderer", () => {
    const catalog = structuredClone(editableCatalog);
    catalog.components.CustomWidget = { type: "object" };
    expect(() => compileComponentSchemas(catalog)).toThrow(/CustomWidget/);
  });
  it("enforces edited constraints while retaining the pinned catalog's behavior", () => {
    const edited = structuredClone(editableCatalog);
    edited.components.Text.allOf.at(-1).properties.variant.enum = ["body"];
    const heading = messages({
      id: "root",
      component: "Text",
      text: "Подборка",
      variant: "h2",
    });
    expect(() => applyUi(empty, heading, edited)).toThrow();
    expect(() => applyUi(empty, heading, editableCatalog)).not.toThrow();
    expect(() =>
      applyUi(
        empty,
        messages({
          id: "root",
          component: "Text",
          text: "Подборка",
          variant: "body",
        }),
        edited,
      ),
    ).not.toThrow();
  });
});
