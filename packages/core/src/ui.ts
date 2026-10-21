import {
  A2uiMessageSchema,
  MessageProcessor,
  STRICT_VALIDATION,
} from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import type { Catalog, ComponentApi } from "@a2ui/web_core/catalog";
import type { Action, UiMessage, UiState } from "../../contracts/src/index.ts";
import { AppError } from "./errors.ts";
import { componentSchemas } from "../../../catalog/index.ts";
import type { ComponentCatalog } from "../../../catalog/index.ts";
const badKeys = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "functionCall",
  "call",
]);
export function safeJson(value: unknown, depth = 0): void {
  if (depth > 32) throw new AppError(422, "ui_depth");
  if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (badKeys.has(key)) throw new AppError(422, "unsupported_expression");
      if (
        key === "path" &&
        typeof child === "string" &&
        child.split("/").some((part) => badKeys.has(part))
      )
        throw new AppError(422, "invalid_path");
      safeJson(child, depth + 1);
    }
}
export function applyUi(
  current: UiState,
  messages: unknown,
  catalog?: ComponentCatalog,
  model: Catalog<ComponentApi> = basicCatalog,
): UiState {
  if (
    !Array.isArray(messages) ||
    messages.length > 32 ||
    JSON.stringify(messages).length > 128000
  )
    throw new AppError(
      422,
      "invalid_ui",
      "Ожидается до 32 сообщений A2UI, не более 128 КБ.",
    );
  safeJson(messages);
  const schemas = componentSchemas(catalog, model);
  const surfaces = new Map<
    string,
    {
      create: UiMessage;
      components: Map<string, Record<string, unknown>>;
      data: unknown;
    }
  >();
  const all = structuredClone([
    ...current.messages,
    ...messages,
  ]) as UiMessage[];
  const processor = new MessageProcessor([model], undefined, {
    version: "v0.9.1",
    validationConfig: STRICT_VALIDATION,
  });
  try {
    for (const message of all) {
      const parsed = A2uiMessageSchema.safeParse(message);
      if (!parsed.success || message.version !== "v0.9.1")
        throw new AppError(
          422,
          "invalid_ui",
          parsed.success
            ? "Ожидается v0.9.1"
            : parsed.error.message.slice(0, 1600),
        );
      const create = message.createSurface as
        | { surfaceId: string; catalogId: string }
        | undefined;
      if (create) {
        if (
          create.catalogId !== model.id ||
          surfaces.has(create.surfaceId) ||
          surfaces.size >= 8
        )
          throw new AppError(422, "invalid_surface");
        surfaces.set(create.surfaceId, {
          create: structuredClone(message),
          components: new Map(),
          data: {},
        });
      }
      const update = message.updateComponents as
        | { surfaceId: string; components: Record<string, unknown>[] }
        | undefined;
      if (update) {
        const surface = surfaces.get(update.surfaceId);
        if (!surface) throw new AppError(422, "missing_surface");
        for (const component of update.components) {
          if (
            component.children !== undefined &&
            !Array.isArray(component.children)
          )
            throw new AppError(422, "unsupported_template");
          if ("validationRegexp" in component)
            throw new AppError(422, "unsupported_validation");
          const name = String(component.component);
          const validate = schemas.get(name);
          if (!validate) throw new AppError(422, "unsupported_component");
          if (!validate(component))
            throw new AppError(
              422,
              "invalid_component",
              `${name}: ${JSON.stringify(validate.errors).slice(0, 1200)}`,
            );
          if (
            component.component === "Button" &&
            !(component.action as { event?: unknown })?.event
          )
            throw new AppError(422, "unsupported_action");
          surface.components.set(
            String(component.id),
            structuredClone(component),
          );
        }
        if (surface.components.size > 200) throw new AppError(422, "ui_size");
      }
      const data = message.updateDataModel as
        | { surfaceId: string; path?: string; value?: unknown }
        | undefined;
      if (data) {
        const surface = surfaces.get(data.surfaceId);
        if (!surface) throw new AppError(422, "missing_surface");
        const path = data.path ?? "/";
        if (path === "/") surface.data = structuredClone(data.value ?? {});
        else {
          if (!path.startsWith("/")) throw new AppError(422, "invalid_path");
          const keys = path
            .slice(1)
            .split("/")
            .map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"));
          if (keys.some((k) => badKeys.has(k)) || keys.length > 16)
            throw new AppError(422, "invalid_path");
          if (
            !surface.data ||
            typeof surface.data !== "object" ||
            Array.isArray(surface.data)
          )
            throw new AppError(422, "invalid_path");
          let target = surface.data as Record<string, unknown>;
          for (const key of keys.slice(0, -1)) {
            if (
              !target[key] ||
              typeof target[key] !== "object" ||
              Array.isArray(target[key])
            )
              target[key] = {};
            target = target[key] as Record<string, unknown>;
          }
          if ("value" in data)
            target[keys.at(-1)!] = structuredClone(data.value);
          else delete target[keys.at(-1)!];
        }
      }
      const remove = message.deleteSurface as { surfaceId: string } | undefined;
      if (remove && !surfaces.delete(remove.surfaceId))
        throw new AppError(422, "missing_surface");
      processor.processMessages(parsed.data);
    }
    const result: UiMessage[] = [];
    for (const [surfaceId, surface] of surfaces) {
      // Limit cycles/depth before a renderer traverses the component graph.
      const visit = (id: string, path: Set<string>): void => {
        if (path.has(id) || path.size > 32)
          throw new AppError(422, "component_cycle");
        const node = surface.components.get(id);
        if (!node) throw new AppError(422, "missing_component", id);
        const children = Array.isArray(node.children)
          ? node.children
          : typeof node.child === "string"
            ? [node.child]
            : [];
        for (const child of children)
          visit(String(child), new Set([...path, id]));
      };
      if (surface.components.size) visit("root", new Set());
      result.push(surface.create);
      if (surface.components.size)
        result.push({
          version: "v0.9.1",
          updateComponents: {
            surfaceId,
            components: [...surface.components.values()],
          },
        });
      result.push({
        version: "v0.9.1",
        updateDataModel: { surfaceId, value: surface.data },
      });
    }
    return {
      messages: result,
      revision: current.revision + (messages.length ? 1 : 0),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      "invalid_ui",
      error instanceof Error ? error.message.slice(0, 1600) : "Ошибка A2UI",
    );
  } finally {
    processor.dispose();
  }
}
export function validateAction(
  ui: UiState,
  revision: number,
  action: Action,
): void {
  if (revision !== ui.revision)
    throw new AppError(409, "stale_ui", "Интерфейс изменился. Обновите экран.");
  safeJson(action);
  let found: Record<string, unknown> | undefined;
  for (const message of ui.messages) {
    const update = message.updateComponents as
      | { surfaceId: string; components: Record<string, unknown>[] }
      | undefined;
    if (update?.surfaceId === action.surfaceId) {
      const reachable = new Set<string>();
      const visit = (id: string): void => {
        if (reachable.has(id)) return;
        reachable.add(id);
        const node = update.components.find((c) => c.id === id);
        const children = Array.isArray(node?.children)
          ? node.children
          : typeof node?.child === "string"
            ? [node.child]
            : [];
        for (const child of children) visit(String(child));
      };
      visit("root");
      if (!reachable.has(action.componentId))
        throw new AppError(422, "invalid_action");
      found = update.components.find((c) => c.id === action.componentId);
    }
  }
  const event = (
    found?.action as {
      event?: { name: string; context?: Record<string, unknown> };
    }
  )?.event;
  if (!event || event.name !== action.name)
    throw new AppError(422, "invalid_action");
  if (
    Object.keys(action.context).some((key) => !(key in (event.context ?? {})))
  )
    throw new AppError(422, "action_context");
  // Static identifiers are immutable; data bindings carry editable form values.
  for (const [key, value] of Object.entries(event.context ?? {}))
    if (
      !(value && typeof value === "object" && "path" in value) &&
      JSON.stringify(action.context[key]) !== JSON.stringify(value)
    )
      throw new AppError(422, "action_context");
  if (JSON.stringify(action.context).length > 16000)
    throw new AppError(422, "action_size");
}
