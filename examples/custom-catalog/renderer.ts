import { html } from "lit";
import { Catalog } from "@a2ui/web_core/catalog";
import { A2uiLitElement } from "@a2ui/lit/v0_9";
import { StatusBadge, document } from "./model.ts";

class StatusBadgeElement extends A2uiLitElement<typeof StatusBadge> {
  static readonly tagName = "example-status-badge";
  protected readonly api = StatusBadge;
  render() {
    return html`<span role="status">${this.controller.props.label}</span>`;
  }
}
export const rendererCatalog = new Catalog(document.catalogId, "0.9", [
  {
    ...StatusBadge,
    tagName: StatusBadgeElement.tagName,
    element: StatusBadgeElement,
  },
]);
