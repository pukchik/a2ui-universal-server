import { html, render } from "lit";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import "@a2ui/lit/v0_9";
import { rendererCatalog } from "./renderer.ts";
import { statusMessages } from "./model.ts";
const processor = new MessageProcessor([rendererCatalog], undefined, {
  version: "v0.9.1",
});
processor.processMessages(statusMessages("Собственный компонент работает"));
render(
  html`${[...processor.getSurfaces().values()].map(
    (surface) => html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
  )}`,
  document.querySelector<HTMLElement>("#preview")!,
);
