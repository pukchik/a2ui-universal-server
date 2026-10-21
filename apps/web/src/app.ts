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
  client = new Client();
  user?: User;
  snapshot?: Snapshot;
  dialogs: { id: string; title: string }[] = [];
  error = "";
  notice = "";
  draft = "";
  sending = false;
  stop?: () => void;
  loading = false;
  openVersion = 0;
  navOpen = false;
  pane: "conversation" | "result" = "conversation";
  selectPane(pane: "conversation" | "result") {
    this.pane = pane;
    this.requestUpdate();
  }
  messageText(text: string) {
    return text === "Действие: search_products"
      ? "Уточнить подборку"
      : text === "Действие: show_product"
        ? "Подробнее о лампе"
        : text;
  }
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
      } else this.clearView();
    } catch (e) {
      this.showError(e);
    }
    this.requestUpdate();
  }
  showError(e: unknown) {
    this.error = e instanceof Error ? e.message : "Не удалось выполнить запрос";
    this.requestUpdate();
  }
  clearView() {
    ++this.openVersion;
    this.stop?.();
    this.stop = undefined;
    this.snapshot = undefined;
    this.dialogs = [];
    this.draft = "";
    this.notice = "";
    this.pane = "conversation";
    this.navOpen = false;
    this.processor.dispose();
    this.processor = new MessageProcessor(
      [basicCatalog],
      (action) => this.action(action),
      { version: "v0.9.1" },
    );
  }
  get savedDialogKey() {
    return `a2ui-dialog:${this.user?.userId ?? "anonymous"}`;
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
    const version = ++this.openVersion;
    this.navOpen = false;
    this.stop?.();
    const snapshot = await this.client.snapshot(id);
    if (version !== this.openVersion) return;
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
    void this.updateComplete.then(() => this.scrollHistory());
  }
  scrollHistory() {
    const history = this.querySelector<HTMLElement>(".conversation-scroll");
    if (history) history.scrollTop = history.scrollHeight;
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
    if (
      !snapshot ||
      event.dialogId !== snapshot.dialog.id ||
      event.seq <= snapshot.throughSeq
    )
      return;
    const payload = event.payload as Record<string, any>;
    snapshot.throughSeq = event.seq;
    if (event.type === "ui.updated") {
      this.pane = "result";
      snapshot.dialog.ui = payload.ui;
      this.resetRenderer(snapshot);
    }
    if (
      event.type === "message.text" &&
      !snapshot.messages.some(
        (message) =>
          message.role === "assistant" && message.runId === event.runId,
      )
    )
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
    if (event.type === "message.text")
      void this.updateComplete.then(() => this.scrollHistory());
  }
  async checkLogin() {
    try {
      const user = await this.client.request<User>("/v1/session");
      if (!user.authenticated) {
        this.user = user;
        this.clearView();
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
    this.pane = "conversation";
    this.draft = "";
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
    const surfaces = [...this.processor.getSurfaces().values()];
    const authenticated = this.user?.authenticated;
    return html`<div class="app-shell">
      <header class="topbar">
        <button
          class="menu-button secondary"
          aria-label="Диалоги"
          aria-controls="dialog-navigation"
          aria-expanded=${this.navOpen}
          @click=${() => {
            this.navOpen = !this.navOpen;
            this.requestUpdate();
          }}
        >
          Диалоги
        </button>
        <a class="brand" href="/" aria-label="A2UI Uniserver — главная">
          <svg class="brand-mark" viewBox="0 0 28 24" aria-hidden="true">
            <path
              d="M10 3H3v18h7M18 3h7v18h-7M8 12h12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            />
          </svg>
          <span>A2UI <span class="brand-sub">/ Uniserver</span></span>
        </a>
        <span class="scope">Каталог ламп</span>
        ${authenticated
          ? html`<button
              class="quiet account"
              @click=${() =>
                this.guarded(async () => {
                  await this.client.request("/auth/logout", {});
                  this.user = undefined;
                  this.clearView();
                  await this.load();
                })}
            >
              Выйти
            </button>`
          : nothing}
      </header>
      <aside
        class=${this.navOpen ? "sidebar is-open" : "sidebar"}
        id="dialog-navigation"
        aria-label="Сохранённые диалоги"
      >
        <div class="sidebar-heading">
          <h2>Диалоги</h2>
          <button
            class="quiet close-menu"
            @click=${() => {
              this.navOpen = false;
              this.requestUpdate();
            }}
          >
            Закрыть
          </button>
        </div>
        <button
          class="new-dialog secondary"
          @click=${() => this.newDialog()}
          ?disabled=${!authenticated || this.busy}
        >
          Новый диалог
        </button>
        <nav aria-label="Диалоги">
          ${this.dialogs.length
            ? this.dialogs.map(
                (d) =>
                  html`<button
                    class=${this.snapshot?.dialog.id === d.id
                      ? "dialog-link selected"
                      : "dialog-link"}
                    aria-current=${this.snapshot?.dialog.id === d.id
                      ? "page"
                      : nothing}
                    title=${d.title}
                    @click=${() => this.guarded(() => this.open(d.id))}
                  >
                    ${d.title}
                  </button>`,
              )
            : html`<p class="nav-empty">
                ${authenticated
                  ? "Здесь появятся ваши диалоги."
                  : "Войдите, чтобы сохранить подборку."}
              </p>`}
        </nav>
        <footer>
          <span class="adapter-name"
            >${this.user?.adapter === "fixture"
              ? "Тестовый адаптер"
              : "Codex CLI"}</span
          >
          <p>
            ${this.user?.adapter === "fixture"
              ? "Без обращений к модели"
              : "Каталог · только чтение"}
          </p>
        </footer>
      </aside>
      <main class="sheet">
        <div class="page-heading">
          <div>
            <h1>Каталог</h1>
            <p>Найдите свет для своего пространства.</p>
          </div>
          <span class="connection"
            >${this.user
              ? this.user.adapter === "fixture"
                ? "Локальная демка"
                : "Codex CLI"
              : "Подключение…"}</span
          >
        </div>
        <div class="mobile-tabs" role="tablist" aria-label="Рабочая область">
          <button
            id="conversation-tab"
            role="tab"
            aria-selected=${this.pane === "conversation"}
            aria-controls="conversation"
            @click=${() => this.selectPane("conversation")}
          >
            Диалог
          </button>
          <button
            id="result-tab"
            role="tab"
            aria-selected=${this.pane === "result"}
            aria-controls="result"
            @click=${() => this.selectPane("result")}
          >
            Результат${surfaces.length
              ? html`<span
                  class="result-dot"
                  aria-label="Есть результат"
                ></span>`
              : nothing}
          </button>
        </div>
        <div class="workbench" data-pane=${this.pane}>
          <section
            id="conversation"
            class="conversation"
            aria-label="Диалог с агентом"
          >
            <div class="panel-heading">
              <h2>Диалог</h2>
              <span class="status" role="status"
                >${authenticated ? this.status() : "Начало работы"}</span
              >
            </div>
            <div class="conversation-scroll">
              ${!this.user
                ? html`<div class="empty-state">
                    <h3>Подключаемся к серверу</h3>
                    <p>Загружаем сессию и сохранённые диалоги.</p>
                    <button class="secondary" @click=${() => this.load()}>
                      Повторить
                    </button>
                  </div>`
                : !authenticated
                  ? html`<div class="welcome">
                      <h3>Какой свет вам нужен?</h3>
                      <p>
                        Расскажите, где будет стоять лампа. Агент подберёт
                        варианты и соберёт форму для уточнений.
                      </p>
                      <p class="muted">
                        Демонстрационный каталог. Покупки и изменения данных
                        недоступны.
                      </p>
                      ${this.user.authMode === "demo"
                        ? html`<button
                              @click=${() =>
                                this.guarded(async () => {
                                  await this.client.request("/auth/demo", {});
                                  await this.load();
                                })}
                              ?disabled=${this.busy}
                            >
                              Открыть демонстрацию
                            </button>
                            <p class="small muted">Локальный вход без OIDC.</p>`
                        : html`<a class="button" href="/auth/login">Войти</a>`}
                    </div>`
                  : this.snapshot?.messages.length
                    ? html`<section class="history" aria-label="История">
                        ${this.snapshot.messages.map(
                          (m) =>
                            html`<article class=${m.role}>
                              <span class="message-author"
                                >${m.role === "user"
                                  ? "Вы"
                                  : "Агент"}${m.incomplete
                                  ? " · ответ прерван"
                                  : ""}</span
                              >
                              <p>${this.messageText(m.text)}</p>
                            </article>`,
                        )}
                      </section>`
                    : html`<div class="empty-state">
                        <h3>Начните с задачи</h3>
                        <p>
                          Для чтения по вечерам, небольшого стола или уютного
                          угла — опишите, что ищете.
                        </p>
                        <div class="suggestions" aria-label="Примеры запросов">
                          ${[
                            "Компактная лампа с тёплым светом",
                            "Лампа для рабочего стола",
                          ].map(
                            (text) =>
                              html`<button
                                class="suggestion"
                                @click=${() => {
                                  this.draft = text;
                                  this.requestUpdate();
                                  void this.updateComplete.then(() =>
                                    this.querySelector<HTMLTextAreaElement>(
                                      "#message",
                                    )?.focus(),
                                  );
                                }}
                              >
                                ${text}<span aria-hidden="true">→</span>
                              </button>`,
                          )}
                        </div>
                      </div>`}
            </div>
            ${authenticated
              ? html`<div class="composer-area">
                  ${this.user?.adapter === "fixture"
                    ? html`<p class="demo-note">
                        Ответы тестовые. Codex не вызывается.
                      </p>`
                    : nothing}
                  ${this.snapshot?.dialog.run?.error
                    ? html`<p class="error" role="alert">
                        ${this.snapshot.dialog.run.error.message}
                      </p>`
                    : nothing}
                  ${this.notice
                    ? html`<p class="notice">${this.notice}</p>`
                    : nothing}
                  <form @submit=${(e: globalThis.Event) => this.send(e)}>
                    <label for="message">Ваш запрос</label>
                    <textarea
                      id="message"
                      placeholder="Например, лампа для чтения до 3 000 ₽"
                      .value=${this.draft}
                      @input=${(e: InputEvent) => {
                        this.draft = (e.target as HTMLTextAreaElement).value;
                      }}
                      ?disabled=${this.busy || !!this.client.pending}
                    ></textarea>
                    <div class="composer-actions">
                      <span class="small muted"
                        >${this.busy
                          ? "Можно остановить запрос"
                          : "Запрос и результат сохранятся"}</span
                      >${this.busy && this.snapshot?.dialog.run
                        ? html`<button
                            type="button"
                            class="secondary"
                            @click=${() => this.cancel()}
                          >
                            Отменить
                          </button>`
                        : html`<button
                            type="submit"
                            ?disabled=${this.busy || !!this.client.pending}
                          >
                            Отправить
                          </button>`}
                    </div>
                  </form>
                </div>`
              : nothing}
            ${this.error
              ? html`<div class="error" role="alert">
                  ${this.error}<button
                    class="quiet"
                    @click=${() => {
                      this.error = "";
                      void this.load();
                    }}
                  >
                    Обновить
                  </button>
                </div>`
              : nothing}
            ${this.client.pending
              ? html`<button
                  class="secondary retry"
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
          </section>
          <section
            id="result"
            class="result-panel"
            aria-label="Результат агента"
          >
            <div class="panel-heading">
              <h2>Результат</h2>
              <span class="revision"
                >${surfaces.length
                  ? `Версия ${this.snapshot?.dialog.ui.revision ?? 0}`
                  : "Пока нет подборки"}</span
              >
            </div>
            <div class="canvas">
              ${surfaces.length
                ? html`<div
                    class="surfaces"
                    aria-label="Результат"
                    ?inert=${this.busy ||
                    this.snapshot?.dialog.run?.status !== "succeeded"}
                  >
                    ${surfaces.map(
                      (surface) =>
                        html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
                    )}
                  </div>`
                : html`<div class="canvas-empty">
                    <span class="canvas-symbol" aria-hidden="true">[ → ]</span>
                    <h3>
                      ${this.busy
                        ? "Агент готовит подборку"
                        : "Место для вашей подборки"}
                    </h3>
                    <p>
                      ${this.busy
                        ? "Результат появится здесь. Можно остаться в диалоге или отменить запрос."
                        : "Здесь появятся товары и форма уточнения. Вы сможете менять подборку прямо в результате."}
                    </p>
                  </div>`}
            </div>
            <div class="canvas-caption">
              <span
                >${surfaces.length
                  ? "Уточняйте подборку через форму"
                  : "Запрос → подборка → уточнение"}</span
              ><span>A2UI</span>
            </div>
          </section>
        </div>
      </main>
    </div>`;
  }
}
customElements.define("uniserver-app", UniserverApp);
