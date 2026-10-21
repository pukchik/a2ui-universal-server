import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  CatalogRegistry,
  defaultCatalog,
  localCatalog,
  remoteCatalog,
  mcpCatalog,
} from "../packages/catalogs/src/index.ts";
const sourceSchema = z
  .object({
    name: z.string(),
    type: z.enum(["local", "https", "mcp"]),
    path: z.string().optional(),
    url: z.string().url().optional(),
    tool: z.string().optional(),
    args: z.record(z.unknown()).optional(),
    tokenEnv: z.string().optional(),
  })
  .strict();
export async function configuredCatalog(path: string) {
  const source = sourceSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const registry = new CatalogRegistry();
  const credential = source.tokenEnv ? process.env[source.tokenEnv] : undefined;
  if (source.tokenEnv && !credential)
    throw new Error("Не настроена авторизация источника каталога");
  const headers: Record<string, string> = credential
    ? { authorization: `Bearer ${credential}` }
    : {};
  if (source.type === "local") {
    if (!source.path) throw new Error("Нужен путь к каталогу");
    registry.register(localCatalog(source.name, source.path));
  } else if (source.type === "https") {
    if (!source.url) throw new Error("Нужен URL каталога");
    registry.register(remoteCatalog(source.name, source.url, headers));
  } else {
    if (!source.url || !source.tool)
      throw new Error("Нужны URL MCP и имя инструмента каталога");
    registry.register(
      mcpCatalog(source.name, source.url, source.tool, source.args, headers),
    );
  }
  const catalog = await registry.get(source.name);
  const builtin = await defaultCatalog();
  // This client has one renderer profile. An arbitrary catalog needs a matching renderer first.
  if (catalog.id !== builtin.id || catalog.digest !== builtin.digest)
    throw new Error(
      "Каталог не соответствует закреплённому профилю рендерера. Подключите совместимый профиль клиента и валидатора.",
    );
  return catalog;
}
