import type { Action, Event, Snapshot } from "../../contracts/src/index.ts";
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export class Client {
  csrf = "";
  pending?: { path: string; body: Record<string, unknown> };
  async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body
        ? { "content-type": "application/json", "x-csrf-token": this.csrf }
        : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok)
      throw new ApiError(
        result.error?.code ?? "http_error",
        result.error?.message ?? "Ошибка сервера",
        response.status,
      );
    return result as T;
  }
  async command<T>(
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.pending)
      throw new Error("Сначала повторите отправку предыдущей команды.");
    this.pending = { path, body: { ...body, commandId: crypto.randomUUID() } };
    return this.retry<T>();
  }
  async retry<T>(): Promise<T> {
    if (!this.pending) throw new Error("Нет команды для повтора");
    const command = this.pending;
    try {
      const result = await this.request<T>(command.path, command.body);
      this.pending = undefined;
      return result;
    } catch (e) {
      if (e instanceof ApiError) this.pending = undefined;
      throw e;
    }
  }
  create() {
    return this.command<{ dialogId: string }>("/v1/dialogs");
  }
  snapshot(id: string) {
    return this.request<Snapshot>(`/v1/dialogs/${id}/snapshot`);
  }
  message(id: string, text: string) {
    return this.command(`/v1/dialogs/${id}/messages`, { text });
  }
  action(id: string, uiRevision: number, action: Action) {
    return this.command(`/v1/dialogs/${id}/actions`, { uiRevision, action });
  }
  cancel(id: string, runId: string) {
    return this.command(`/v1/dialogs/${id}/runs/${runId}/cancel`);
  }
  watch(
    id: string,
    after: number,
    onEvent: (event: Event) => void,
    onReset: () => void,
    onError: () => void,
  ) {
    const source = new EventSource(`/v1/dialogs/${id}/events?after=${after}`);
    let cursor = after;
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as Event;
        if (event.dialogId !== id || event.seq <= cursor) return;
        if (event.seq !== cursor + 1) {
          source.close();
          onReset();
          return;
        }
        onEvent(event);
        cursor = event.seq;
      } catch {
        source.close();
        onReset();
      }
    };
    source.onerror = onError;
    return () => source.close();
  }
}
