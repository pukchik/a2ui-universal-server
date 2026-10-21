import type { CatalogSnapshot } from "../../../../packages/catalogs/src/index.ts";
import type {
  ChatMessage,
  Dialog,
  Run,
} from "../../../../packages/contracts/src/index.ts";
export type AgentContext = {
  run: Run;
  dialog: Dialog;
  history: ChatMessage[];
  taskState?: Record<string, unknown>;
  catalog?: CatalogSnapshot;
  instructions?: string;
  toolUrl: string;
  token: string;
  repair?: { output: string; error: string; results: unknown[] };
};
export type AgentOutput = { text: string; a2uiJson: string };
export type ToolCaller = (
  name: string,
  args: unknown,
  id: string,
) => Promise<unknown>;
export interface AgentAdapter {
  kind: "agent";
  run(
    context: AgentContext,
    callTool: ToolCaller,
    signal: AbortSignal,
  ): Promise<AgentOutput>;
}
export type ModelReply =
  | { type: "output"; output: AgentOutput }
  | {
      type: "tool_calls";
      calls: { id: string; name: string; args: unknown }[];
    };
export interface ModelAdapter {
  kind: "model";
  step(
    context: AgentContext,
    results: { id: string; result: unknown }[],
    signal: AbortSignal,
  ): Promise<ModelReply>;
}
export type Adapter = AgentAdapter | ModelAdapter;
export async function runAdapter(
  adapter: Adapter,
  context: AgentContext,
  callTool: ToolCaller,
  signal: AbortSignal,
): Promise<AgentOutput> {
  if (adapter.kind === "agent") return adapter.run(context, callTool, signal);
  const results: { id: string; result: unknown }[] = [];
  for (let step = 0; step < 8; step++) {
    if (signal.aborted) throw signal.reason;
    const response = await adapter.step(context, results, signal);
    if (response.type === "output") return response.output;
    for (const call of response.calls) {
      results.push({
        id: call.id,
        result: await callTool(call.name, call.args, call.id),
      });
    }
  }
  throw new Error("Превышен лимит шагов модели");
}
