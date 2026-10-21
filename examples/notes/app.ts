import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { startServer, configFrom } from "../../server/index.ts";
import type {
  AuthProvider,
  AuthSession,
  ToolRegistry,
  AgentAdapter,
} from "../../server/index.ts";
import { AppError } from "../../packages/core/src/errors.ts";
import { CATALOG_ID } from "../../packages/contracts/src/index.ts";

const notes = [
  {
    id: "alice-1",
    userId: "notes:alice",
    title: "Заметка Алисы",
    text: "Личная запись Алисы",
  },
  {
    id: "bob-1",
    userId: "notes:bob",
    title: "Заметка Боба",
    text: "Личная запись Боба",
  },
];

export function notesOptions() {
  const sessions = new Map<string, AuthSession>();
  // Local example of a host application's existing session store.
  const auth: AuthProvider = {
    resolve: (request) => sessions.get(request.cookies.notes_session ?? ""),
    login(request, reply) {
      const selected =
        new URL(request.url, "http://localhost").searchParams.get("user") ??
        "alice";
      if (!["alice", "bob"].includes(selected))
        throw new AppError(400, "unknown_example_user");
      const cookie = randomBytes(32).toString("hex");
      sessions.set(cookie, {
        userId: `notes:${selected}`,
        name: selected,
        csrf: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 3600000),
      });
      reply.setCookie("notes_session", cookie, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      });
      return { ok: true, exampleOnly: true };
    },
    logout(request, reply) {
      sessions.delete(request.cookies.notes_session ?? "");
      reply.clearCookie("notes_session", { path: "/" });
    },
  };
  const tools: ToolRegistry = {
    list_notes: {
      description: "Личные заметки текущего пользователя",
      schema: z.object({ query: z.string().max(200).default("") }).strict(),
      execute: ({ query }: { query: string }, context) => {
        context.signal.throwIfAborted();
        return notes.filter(
          (note) =>
            note.userId === context.userId && note.title.includes(query),
        );
      },
    },
    get_note: {
      description: "Открыть доступную текущему пользователю заметку",
      schema: z.object({ id: z.string() }).strict(),
      execute: ({ id }: { id: string }, context) => {
        const note = notes.find(
          (note) => note.id === id && note.userId === context.userId,
        );
        if (!note) throw new AppError(404, "note_not_found");
        return note;
      },
    },
  };
  const adapter: AgentAdapter = {
    kind: "agent",
    async run(context, callTool) {
      const action = context.run.input.action;
      const result =
        action?.name === "open_note"
          ? [await callTool("get_note", { id: action.context.id }, "get")]
          : await callTool(
              "list_notes",
              { query: action?.context.query ?? "" },
              "list",
            );
      const selected = result as typeof notes;
      return {
        text: selected.map((note) => note.title).join(", ") || "Заметок нет",
        a2uiJson: JSON.stringify([
          ...(context.dialog.ui.revision
            ? [{ version: "v0.9.1", deleteSurface: { surfaceId: "notes" } }]
            : []),
          {
            version: "v0.9.1",
            createSurface: { surfaceId: "notes", catalogId: CATALOG_ID },
          },
          {
            version: "v0.9.1",
            updateComponents: {
              surfaceId: "notes",
              components: [
                {
                  id: "root",
                  component: "Column",
                  children: [
                    "query",
                    "search",
                    ...selected.map((note) => note.id),
                  ],
                },
                {
                  id: "query",
                  component: "TextField",
                  label: "Название",
                  value: { path: "/query" },
                },
                { id: "search-label", component: "Text", text: "Найти" },
                {
                  id: "search",
                  component: "Button",
                  child: "search-label",
                  action: {
                    event: {
                      name: "search",
                      context: { query: { path: "/query" } },
                    },
                  },
                },
                ...selected.flatMap((note) => [
                  {
                    id: note.id,
                    component: "Column",
                    children: [`${note.id}-text`, `${note.id}-button`],
                  },
                  {
                    id: `${note.id}-text`,
                    component: "Text",
                    text: action?.name === "open_note" ? note.text : note.title,
                  },
                  {
                    id: `${note.id}-label`,
                    component: "Text",
                    text: "Открыть",
                  },
                  {
                    id: `${note.id}-button`,
                    component: "Button",
                    child: `${note.id}-label`,
                    action: {
                      event: { name: "open_note", context: { id: note.id } },
                    },
                  },
                ]),
              ],
            },
          },
          {
            version: "v0.9.1",
            updateDataModel: { surfaceId: "notes", value: { query: "" } },
          },
        ]),
      };
    },
  };
  return {
    adapter,
    adapterName: "notes-fixture",
    auth,
    tools,
    instructions: "Локальный пример личных заметок. Данные учебные.",
  };
}

export async function startNotesExample(
  env = process.env,
  handleSignals = true,
) {
  const config = configFrom({ ...env, AUTH_MODE: "custom" });
  if (
    config.HOST !== "127.0.0.1" ||
    new URL(config.PUBLIC_URL).hostname !== "localhost"
  )
    throw new Error(
      "Учебный вход notes разрешён только на 127.0.0.1 / localhost",
    );
  return startServer(config, {
    ...notesOptions(),
    logger: false,
    handleSignals,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = await startNotesExample();
  console.log(
    `Notes example listening at ${JSON.stringify(server.app.server.address())}`,
  );
}
