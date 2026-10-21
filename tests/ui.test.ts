import { describe, it, expect } from "vitest";
import { applyUi, validateAction } from "../packages/core/src/ui.ts";
import { productUi } from "../demo/server/tools.ts";
const empty = { messages: [], revision: 0 };
describe("A2UI protocol and application profile", () => {
  it("validates real Basic Catalog messages and restores the same UI", () => {
    const state = applyUi(empty, productUi());
    expect(state.revision).toBe(1);
    const restored = applyUi(empty, state.messages);
    expect(restored.messages).toEqual(state.messages);
  });
  it("applies component and data changes without mutating the original", () => {
    const state = applyUi(empty, productUi());
    const next = applyUi(state, [
      {
        version: "v0.9.1",
        updateDataModel: {
          surfaceId: "products",
          path: "/query",
          value: "лампы",
        },
      },
    ]);
    expect(next.revision).toBe(2);
    expect(state.messages).not.toEqual(next.messages);
  });
  it("rejects an entire batch when a later message is invalid", () => {
    expect(() =>
      applyUi(empty, [
        ...productUi(),
        { version: "v0.9.1", deleteSurface: { surfaceId: "absent" } },
      ]),
    ).toThrow();
    expect(empty.revision).toBe(0);
  });
  it("rejects incompatible versions, remote media and executable functions", () => {
    expect(() =>
      applyUi(empty, [
        { version: "v0.8", createSurface: { surfaceId: "x", catalogId: "x" } },
      ]),
    ).toThrow();
    const media = productUi();
    (media[1].updateComponents as { components: unknown[] }).components.push({
      id: "image",
      component: "Image",
      url: "https://example.com/a.png",
    });
    expect(() => applyUi(empty, media)).toThrow();
    expect(() =>
      applyUi(empty, [
        {
          version: "v0.9.1",
          updateDataModel: {
            surfaceId: "products",
            value: { functionCall: {} },
          },
        },
      ]),
    ).toThrow();
  });
  it("detects cycles and prototype pollution", () => {
    const cyclic = productUi();
    (cyclic[1].updateComponents as { components: unknown[] }).components[0] = {
      id: "root",
      component: "Column",
      children: ["root"],
    };
    expect(() => applyUi(empty, cyclic)).toThrow();
    expect(() => applyUi(empty, JSON.parse('[{"constructor":{}}]'))).toThrow();
  });
  it("checks action identity, revision and static context", () => {
    const state = applyUi(empty, productUi());
    const action = {
      surfaceId: "products",
      componentId: "button-lamp-1",
      name: "show_product",
      context: { productId: "lamp-1" },
    };
    expect(() => validateAction(state, 1, action)).not.toThrow();
    expect(() => validateAction(state, 0, action)).toThrow(
      "Интерфейс изменился",
    );
    expect(() =>
      validateAction(state, 1, { ...action, context: { productId: "lamp-3" } }),
    ).toThrow();
    expect(() =>
      validateAction(state, 1, { ...action, componentId: "absent" }),
    ).toThrow();
    expect(() =>
      validateAction(state, 1, {
        ...action,
        context: { ...action.context, extra: true },
      }),
    ).toThrow();
    const hidden = productUi();
    const components = (
      hidden[1].updateComponents as { components: Record<string, unknown>[] }
    ).components;
    components.find((c) => c.id === "root")!.children = ["heading"];
    expect(() => validateAction(applyUi(empty, hidden), 1, action)).toThrow();
  });
});

it("accepts editable form context but rejects stale revisions", () => {
  const state = applyUi({ messages: [], revision: 0 }, productUi());
  const action = {
    surfaceId: "products",
    componentId: "search-button",
    name: "search_products",
    context: { query: "Мини" },
  };
  expect(() => validateAction(state, 1, action)).not.toThrow();
  expect(() => validateAction(state, 0, action)).toThrow();
});
