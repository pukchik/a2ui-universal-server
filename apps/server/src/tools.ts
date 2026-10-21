import type { AnyZodObject } from "zod";

export type ToolDefinition = {
  description: string;
  schema: AnyZodObject;
  execute(args: never): unknown | Promise<unknown>;
};
export type ToolRegistry = Record<string, ToolDefinition>;
