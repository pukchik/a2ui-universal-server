import { LitElement, html, nothing } from "lit";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import type { ActionPayload } from "@a2ui/web_core/v0_9";
import { setMarkdownRenderer } from "@a2ui/web_core/v0_9/basic_catalog";
import { basicCatalog } from "@a2ui/lit/v0_9";
import { Client, ApiError } from "../../../packages/client/src/index.ts";
import { CATALOG_ID, PROFILE } from "../../../packages/contracts/src/index.ts";
import type {
  Event,
  Json,
  Snapshot,
} from "../../../packages/contracts/src/index.ts";
import "./style.css";
type User = {
  authenticated: boolean;
  userId?: string;
  name?: string;
  csrf?: string;
  authMode: string;
  adapter: string;
  publicDemo: boolean;
};
// This profile displays text without HTML or active Markdown content.
setMarkdownRenderer(async (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;"),
);
class UniserverApp extends LitElement {
  client = new Client(new URL(document.baseURI).pathname);
  user?: User;
  snapshot?: Snapshot;
  dialogs: { id: string; title: string }[] = [];
  error = "";
  notice = "";
  draft = "";
  sending = false;
  stop?: () => void;
  loading = false;
  processor = new MessageProcessor(
    [basicCatalog],
    (action) => this.action(action),
    { version: "v0.9.1" },
  );
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }
  disconnectedCallback() {
    this.stop?.();
    this.processor.dispose();
    super.disconnectedCallback();
  }
  async load() {
    try {
      this.user = await this.client.request<User>("/v1/session");
      this.client.csrf = this.user.csrf ?? "";
      if (this.user.authenticated) {
        this.dialogs = await this.client.request("/v1/dialogs");
        const saved = localStorage.getItem(this.savedDialogKey);
        if (saved && this.dialogs.some((dialog) => dialog.id === saved))
          try {
            await this.open(saved);
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 404)) throw e;
          }
      }
    } catch (e) {
      this.showError(e);
    }
    this.requestUpdate();
  }
  showError(e: unknown) {
    this.error = e instanceof Error ? e.message : "Не удалось выполнить запрос";
    this.requestUpdate();
  }
  get savedDialogKey() {
    return `a2ui-dialog:${this.client.basePath}:${this.user?.userId ?? "anonymous"}`;
  }
  async guarded(fn: () => Promise<void>) {
    if (this.sending) return;
    this.error = "";
    this.sending = true;
    this.requestUpdate();
    try {
      await fn();
    } catch (e) {
      this.showError(e);
    } finally {
      this.sending = false;
      this.requestUpdate();
    }
  }
  resetRenderer(snapshot: Snapshot) {
    if (
      snapshot.protocol !== "v0.9.1" ||
      snapshot.catalogId !== CATALOG_ID ||
      snapshot.profile !== PROFILE
    )
      throw new Error("Несовместимая версия интерфейса");
    this.processor.dispose();
    this.processor = new MessageProcessor(
      [basicCatalog],
      (a) => this.action(a),
      { version: "v0.9.1" },
    );
    this.processor.processMessages(
      snapshot.dialog.ui.messages as Parameters<
        MessageProcessor["processMessages"]
      >[0],
    );
  }
  async open(id: string, recovery = false) {
    this.stop?.();
    const snapshot = await this.client.snapshot(id);
    this.resetRenderer(snapshot);
    this.snapshot = snapshot;
    localStorage.setItem(this.savedDialogKey, id);
    if (recovery)
      this.notice =
        "Интерфейс восстановлен. Несохранённый ввод в его полях сброшен.";
    this.stop = this.client.watch(
      id,
      snapshot.throughSeq,
      (event) => this.event(event),
      () => void this.recover(id),
      () => void this.checkLogin(),
    );
    this.requestUpdate();
  }
  async recover(id: string) {
    if (this.loading) return;
    this.loading = true;
    try {
      await this.open(id, true);
    } catch (e) {
      this.showError(e);
    } finally {
      this.loading = false;
    }
  }
  event(event: Event) {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const payload = event.payload as Record<string, any>;
    snapshot.throughSeq = event.seq;
    if (event.type === "ui.updated") {
      snapshot.dialog.ui = payload.ui;
      this.resetRenderer(snapshot);
    }
    if (event.type === "message.text")
      snapshot.messages.push({
        role: "assistant",
        text: payload.text,
        runId: event.runId!,
      });
    if (event.type.startsWith("run.")) {
      const status = event.type.slice(4) as NonNullable<
        Snapshot["dialog"]["run"]
      >["status"];
      if (snapshot.dialog.run && snapshot.dialog.run.id === event.runId) {
        snapshot.dialog.run.status = status;
        if (status === "failed")
          snapshot.dialog.run.error = {
            code: payload.code,
            message: payload.message,
          };
      } else {
        void this.recover(snapshot.dialog.id);
      }
    }
    this.requestUpdate();
  }
  async checkLogin() {
    try {
      const user = await this.client.request<User>("/v1/session");
      if (!user.authenticated) {
        this.stop?.();
        this.user = user;
        this.snapshot = undefined;
        this.requestUpdate();
      }
    } catch {}
  }
  get busy() {
    return (
      this.sending ||
      (!!this.snapshot?.dialog.run &&
        ["queued", "running"].includes(this.snapshot.dialog.run.status))
    );
  }
  async newDialog() {
    await this.guarded(async () => {
      const { dialogId } = await this.client.create();
      await this.open(dialogId);
      this.dialogs = await this.client.request("/v1/dialogs");
    });
  }
  async send(e: globalThis.Event) {
    e.preventDefault?.();
    const text = this.draft.trim();
    if (!text || this.busy) return;
    await this.guarded(async () => {
      if (!this.snapshot) {
        const { dialogId } = await this.client.create();
        await this.open(dialogId);
      }
      await this.client.message(this.snapshot!.dialog.id, text);
      this.draft = "";
      await this.open(this.snapshot!.dialog.id);
      this.dialogs = await this.client.request("/v1/dialogs");
    });
  }
  async action(action: ActionPayload) {
    if (this.busy || this.snapshot?.dialog.run?.status !== "succeeded") return;
    await this.guarded(async () => {
      try {
        await this.client.action(
          this.snapshot!.dialog.id,
          this.snapshot!.dialog.ui.revision,
          {
            surfaceId: action.surfaceId,
            componentId: action.sourceComponentId,
            name: action.name,
            context: action.context as Record<string, Json>,
          },
        );
        await this.open(this.snapshot!.dialog.id);
      } catch (e) {
        if (e instanceof ApiError && e.code === "stale_ui")
          await this.open(this.snapshot!.dialog.id, true);
        throw e;
      }
    });
  }
  async cancel() {
    if (!this.snapshot?.dialog.run) return;
    await this.guarded(async () => {
      await this.client.cancel(
        this.snapshot!.dialog.id,
        this.snapshot!.dialog.run!.id,
      );
      await this.open(this.snapshot!.dialog.id);
    });
  }
  status() {
    const status = this.snapshot?.dialog.run?.status;
    return status
      ? {
          queued: "Запрос принят",
          running: "Агент работает",
          succeeded: "Готово",
          cancelled: "Запрос отменён",
          failed: "Ошибка выполнения",
        }[status]
      : "Готов к работе";
  }
  render() {
    return html`<div class="layout">
      <aside>
        <a class="brand" href=${this.client.basePath}
          >a2ui<span>/ uniserver</span></a
        >
        <div class="project-label">Демонстрационный каталог</div>
        <button
          class="new-dialog"
          @click=${() => this.newDialog()}
          ?disabled=${!this.user?.authenticated || this.busy}
        >
          ＋ Новый диалог
        </button>
        <nav aria-label="Диалоги">
          ${this.dialogs.map(
            (d) =>
              html`<button
                class=${this.snapshot?.dialog.id === d.id ? "selected" : ""}
                @click=${() => this.guarded(() => this.open(d.id))}
              >
                ${d.title}
              </button>`,
          )}
        </nav>
        <footer>Первая версия · 0.1.0<br />Codex CLI + A2UI</footer>
      </aside>
      <main>
        <header>
          <div>
            <span class="eyebrow">AGENT WORKSPACE</span>
            <h1>
              ${this.snapshot?.dialog.title ??
              "Каталог с интерфейсом от агента"}
            </h1>
          </div>
          ${this.user?.authenticated
            ? html`<button
                class="quiet"
                @click=${() =>
                  this.guarded(async () => {
                    await this.client.request("/auth/logout", {});
                    this.stop?.();
                    this.user = undefined;
                    this.snapshot = undefined;
                    this.dialogs = [];
                    await this.load();
                  })}
              >
                Выйти
              </button>`
            : nothing}
        </header>
        ${!this.user
          ? html`<p>Подключение…</p>`
          : !this.user.authenticated
            ? html`<section class="welcome">
                <span class="tag">A2UI UNISERVER</span>
                <h2>Начните с одного вопроса</h2>
                <p>
                  Агент найдёт товары и соберёт удобный интерфейс для
                  результата. В примере используются демонстрационные данные.
                </p>
                ${this.user.authMode === "demo"
                  ? html`<p class="demo-note">
                        ${this.user.publicDemo
                          ? "Тестовый стенд. Модель не вызывается; данные сбрасываются при обновлении стенда."
                          : "Локальный демо-режим. Доступен только на этом компьютере."}
                      </p>
                      <button
                        @click=${() =>
                          this.guarded(async () => {
                            await this.client.request("/auth/demo", {});
                            await this.load();
                          })}
                      >
                        Открыть демонстрацию
                      </button>`
                  : html`<a
                      class="button"
                      href=${this.client.url("/auth/login")}
                      >Войти</a
                    >`}
              </section>`
            : html`<section class="workspace">
                ${this.user.adapter === "fixture"
                  ? html`<div class="demo-note">
                      Тестовый адаптер. Ответы детерминированы; Codex не
                      вызывается.
                    </div>`
                  : nothing}${this.snapshot?.messages.length
                  ? html`<section class="history" aria-label="История">
                      ${this.snapshot.messages.map(
                        (m) =>
                          html`<article class=${m.role}>
                            <small
                              >${m.role === "user"
                                ? "Вы"
                                : "Агент"}${m.incomplete
                                ? " · незавершённый ответ"
                                : ""}</small
                            >
                            <p>${m.text}</p>
                          </article>`,
                      )}
                    </section>`
                  : html`<div class="empty">
                      <span class="tag">ДАННЫЕ → ИНТЕРФЕЙС</span>
                      <h2>Что будем искать?</h2>
                      <p>
                        Например: «Покажи компактные лампы с тёплым светом».
                      </p>
                    </div>`}
                <div class="status" role="status">
                  <span class=${this.busy ? "dot working" : "dot"}></span
                  >${this.status()}${this.busy && this.snapshot?.dialog.run
                    ? html`<button class="quiet" @click=${() => this.cancel()}>
                        Отменить
                      </button>`
                    : nothing}
                </div>
                ${this.snapshot?.dialog.run?.error
                  ? html`<p class="error" role="alert">
                      ${this.snapshot.dialog.run.error.message}
                    </p>`
                  : nothing}
                <section
                  class="surfaces"
                  aria-label="Результат"
                  ?inert=${this.busy ||
                  this.snapshot?.dialog.run?.status !== "succeeded"}
                >
                  ${[...this.processor.getSurfaces().values()].map(
                    (surface) =>
                      html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
                  )}
                </section>
                <form @submit=${(e: globalThis.Event) => this.send(e)}>
                  <label for="message">Ваш запрос</label>
                  <div class="composer">
                    <textarea
                      id="message"
                      placeholder="Опишите, что хотите найти…"
                      .value=${this.draft}
                      @input=${(e: InputEvent) => {
                        this.draft = (e.target as HTMLTextAreaElement).value;
                      }}
                      ?disabled=${this.busy || !!this.client.pending}
                    ></textarea
                    ><button
                      type="submit"
                      ?disabled=${this.busy || !!this.client.pending}
                    >
                      Отправить ↗
                    </button>
                  </div>
                  <small
                    >Демонстрационные товары. Действия только для чтения.</small
                  >
                </form>
              </section>`}${this.notice
          ? html`<p class="notice">${this.notice}</p>`
          : nothing}${this.error
          ? html`<p class="error" role="alert">${this.error}</p>`
          : nothing}${this.client.pending
          ? html`<button
              @click=${() =>
                this.guarded(async () => {
                  const result = await this.client.retry<{
                    dialogId?: string;
                    runId?: string;
                  }>();
                  if (result.dialogId) await this.open(result.dialogId);
                  else if (this.snapshot)
                    await this.open(this.snapshot.dialog.id);
                  if (result.runId) this.draft = "";
                })}
            >
              Повторить отправку
            </button>`
          : nothing}
      </main>
    </div>`;
  }
}
customElements.define("uniserver-app", UniserverApp);
