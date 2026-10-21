import { Catalog } from "@a2ui/web_core/catalog";
import { z } from "zod";
import document from "./catalog.json" with { type: "json" };
export { document };
export const StatusBadge = {
  name: "StatusBadge",
  schema: z.object({ label: z.string().min(1) }).strict(),
};
export const modelCatalog = new Catalog(document.catalogId, "0.9", [
  StatusBadge,
]);
export const statusMessages = (label: string) => [
  {
    version: "v0.9.1" as const,
    createSurface: { surfaceId: "status", catalogId: document.catalogId },
  },
  {
    version: "v0.9.1" as const,
    updateComponents: {
      surfaceId: "status",
      components: [{ id: "root", component: "StatusBadge", label }],
    },
  },
];
