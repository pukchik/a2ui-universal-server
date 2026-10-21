import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { Engine } from "./engine.ts";
import { AppError } from "../packages/core/src/errors.ts";
export function registerMcp(app: FastifyInstance, engine: Engine) {
  app.post("/internal/mcp", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer "))
      throw new AppError(401, "run_token_required");
    const run = engine.authorize(auth.slice(7));
    await engine.store.active(engine.store.pool, run);
    if (req.headers.origin) throw new AppError(403, "mcp_browser_origin");
    const server = new McpServer({ name: "a2ui-project", version: "0.1.0" });
    for (const [name, tool] of Object.entries(engine.tools))
      server.registerTool(
        name,
        {
          description: tool.description,
          inputSchema: tool.schema.shape as ZodRawShape,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
        async (
          args: Record<string, unknown>,
          extra: { requestId: string | number },
        ): Promise<CallToolResult> => {
          try {
            engine.authorize(auth.slice(7));
            const result = await engine.callTool(
              run,
              name,
              args,
              `mcp:${String(extra.requestId)}`,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: error instanceof AppError ? error.code : "tool_failed",
                },
              ],
            };
          }
        },
      );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.once("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.get("/internal/mcp", async (_req, reply) =>
    reply.code(405).header("allow", "POST").send(),
  );
  app.delete("/internal/mcp", async (_req, reply) =>
    reply.code(405).header("allow", "POST").send(),
  );
}
