import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CATALOG_ID, PROFILE } from "../../contracts/src/index.ts";
export const supportedComponents = [
  "Text",
  "Column",
  "Row",
  "Button",
  "TextField",
  "Divider",
  "Card",
] as const;
const documentSchema = z
  .object({
    catalogId: z.string().min(1),
    components: z.record(z.unknown()),
    functions: z.unknown().optional(),
  })
  .passthrough();
export type CatalogSnapshot = {
  id: string;
  protocol: "v0.9.1";
  version: string;
  digest: string;
  profile: string;
  document: Record<string, unknown>;
  common: Record<string, unknown>;
};
export type CatalogSource = { name: string; load: () => Promise<unknown> };
export class CatalogRegistry {
  private sources = new Map<string, CatalogSource>();
  private cache = new Map<string, CatalogSnapshot>();
  register(source: CatalogSource) {
    if (this.sources.has(source.name))
      throw new Error("Источник каталога уже зарегистрирован");
    this.sources.set(source.name, source);
  }
  async get(name: string): Promise<CatalogSnapshot> {
    const cached = this.cache.get(name);
    return structuredClone(cached ?? (await this.refresh(name)));
  }
  async refresh(name: string): Promise<CatalogSnapshot> {
    const source = this.sources.get(name);
    if (!source) throw new Error("Неизвестный источник каталога");
    const raw = await source.load();
    const parsed = documentSchema.parse(raw);
    if (JSON.stringify(parsed).length > 256000)
      throw new Error("Каталог слишком большой");
    const document = JSON.parse(JSON.stringify(parsed)) as Record<
      string,
      unknown
    >;
    const common = (document.common ?? {}) as Record<string, unknown>;
    const digest = createHash("sha256")
      .update(JSON.stringify(document))
      .digest("hex");
    const snapshot: CatalogSnapshot = {
      id: parsed.catalogId,
      protocol: "v0.9.1",
      version: String(
        document.version ?? document.protocolVersion ?? "unversioned",
      ),
      digest,
      profile: String(document.profile ?? PROFILE),
      document,
      common,
    };
    this.cache.set(name, structuredClone(snapshot));
    return structuredClone(snapshot);
  }
}
export function localCatalog(name: string, path: string): CatalogSource {
  return { name, load: async () => JSON.parse(await readFile(path, "utf8")) };
}
// Sources are registered by the operator, never supplied in browser requests.
export function remoteCatalog(
  name: string,
  url: string,
  headers: Record<string, string> = {},
): CatalogSource {
  const target = new URL(url);
  if (target.protocol !== "https:")
    throw new Error("Удалённый каталог требует HTTPS");
  return {
    name,
    load: async () => {
      const response = await fetch(target, {
        headers,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Источник каталога недоступен");
      const reader = response.body!.getReader();
      let text = "",
        size = 0;
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 256000) {
          await reader.cancel();
          throw new Error("Каталог слишком большой");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    },
  };
}
export function mcpCatalog(
  name: string,
  url: string,
  tool: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): CatalogSource {
  return {
    name,
    load: async () => {
      const client = new Client({
        name: "a2ui-catalog-loader",
        version: "0.1.0",
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers },
          }),
        );
        const result = await client.callTool(
          { name: tool, arguments: args },
          undefined,
          { timeout: 10000 },
        );
        if (result.isError) throw new Error("MCP не вернул каталог");
        if (result.structuredContent) return result.structuredContent;
        const content = result.content as { type: string; text?: string }[];
        const text = content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
        if (text.length > 256000) throw new Error("Каталог слишком большой");
        return JSON.parse(text);
      } finally {
        await client.close();
      }
    },
  };
}
export async function defaultCatalog(): Promise<CatalogSnapshot> {
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve("@a2ui/web_core/v0_9")), "schemas");
  const catalog = JSON.parse(
    await readFile(join(dir, "catalogs/basic/catalog.json"), "utf8"),
  );
  catalog.components = Object.fromEntries(
    supportedComponents.map((name) => [name, catalog.components[name]]),
  );
  catalog.functions = {};
  catalog.version = "0.14.0";
  catalog.profile = PROFILE;
  catalog.common = JSON.parse(
    await readFile(join(dir, "common_types.json"), "utf8"),
  );
  const registry = new CatalogRegistry();
  registry.register({ name: "basic", load: async () => catalog });
  const snapshot = await registry.get("basic");
  if (snapshot.id !== CATALOG_ID)
    throw new Error("Неподдерживаемый каталог SDK");
  return snapshot;
}
