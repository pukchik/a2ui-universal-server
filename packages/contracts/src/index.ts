import type { CatalogSnapshot } from "../../catalogs/src/index.ts";
import { Type } from "@sinclair/typebox";
import catalog from "../../../catalog/catalog.json" with { type: "json" };
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type UiMessage = { version: "v0.9.1"; [key: string]: unknown };
export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type Run = {
  id: string;
  dialogId: string;
  status: RunStatus;
  error?: { code: string; message: string };
  generation: string;
  input: { text?: string; action?: Action };
};
export type Action = {
  surfaceId: string;
  componentId: string;
  name: string;
  context: Record<string, Json>;
};
export type UiState = { messages: UiMessage[]; revision: number };
export type Dialog = {
  taskState?: Record<string, Json>;
  mode?: "dialog" | "generation";
  catalog?: CatalogSnapshot;
  id: string;
  userId: string;
  title: string;
  seq: number;
  ui: UiState;
  run: Run | null;
  createdAt: string;
};
export type Event = {
  dialogId: string;
  seq: number;
  type: string;
  runId?: string;
  payload: Json;
  createdAt: string;
};
export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  runId: string;
  incomplete?: boolean;
};
export type Snapshot = {
  dialog: Dialog;
  messages: ChatMessage[];
  throughSeq: number;
  protocol: "v0.9.1";
  catalogId: string;
  profile: string;
};
export const commandId = Type.String({ format: "uuid" });
export const createDialogSchema = Type.Object(
  { commandId },
  { additionalProperties: false },
);
export const messageSchema = Type.Object(
  { commandId, text: Type.String({ minLength: 1, maxLength: 12000 }) },
  { additionalProperties: false },
);
export const actionSchema = Type.Object(
  {
    commandId,
    uiRevision: Type.Integer({ minimum: 0 }),
    action: Type.Object(
      {
        surfaceId: Type.String({ minLength: 1, maxLength: 100 }),
        componentId: Type.String({ minLength: 1, maxLength: 100 }),
        name: Type.String({ minLength: 1, maxLength: 100 }),
        context: Type.Record(Type.String(), Type.Unknown()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const cancelSchema = Type.Object(
  { commandId },
  { additionalProperties: false },
);
export const CATALOG_ID = catalog.catalogId;
export const PROFILE = catalog.profile;
