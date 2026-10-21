import type { AnyZodObject } from "zod";

export type ToolContext = Readonly<{
  userId: string;
  dialogId: string;
  runId: string;
  signal: AbortSignal;
}>;

export type ToolDefinition = {
  description: string;
  schema: AnyZodObject;
  execute(args: never, context: ToolContext): unknown | Promise<unknown>;
};
export type ToolRegistry = Record<string, ToolDefinition>;
