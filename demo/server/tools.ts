import { z } from "zod";
import type { UiMessage } from "../../packages/contracts/src/index.ts";
import { CATALOG_ID } from "../../packages/contracts/src/index.ts";
export const products = [
  {
    id: "lamp-1",
    name: "Лампа «Тёплый вечер»",
    description: "Компактная настольная лампа, тёплый свет 2700 K.",
    price: 2490,
    color: "тёплый",
    compact: true,
  },
  {
    id: "lamp-2",
    name: "Лампа «Рабочий стол»",
    description: "Регулируемая настольная лампа, нейтральный свет 4000 K.",
    price: 3290,
    color: "нейтральный",
    compact: false,
  },
  {
    id: "lamp-3",
    name: "Лампа «Мини»",
    description: "Небольшая лампа с тёплым светом 3000 K.",
    price: 1790,
    color: "тёплый",
    compact: true,
  },
];
export const toolDefinitions = {
  search_products: {
    description:
      "Поиск по демонстрационному каталогу ламп. Данные демонстрационные.",
    schema: z
      .object({
        query: z.string().max(200).optional(),
        warm: z.boolean().optional(),
        compact: z.boolean().optional(),
      })
      .strict(),
    execute: (args: { query?: string; warm?: boolean; compact?: boolean }) =>
      products.filter(
        (p) =>
          (!args.warm || p.color === "тёплый") &&
          (!args.compact || p.compact) &&
          (!args.query ||
            /ламп|свет|lamp/i.test(args.query) ||
            p.name.toLowerCase().includes(args.query.toLowerCase())),
      ),
  },
  get_product: {
    description: "Подробности демонстрационного товара по ID.",
    schema: z.object({ id: z.string().max(100) }).strict(),
    execute: (args: { id: string }) => {
      const result = products.find((p) => p.id === args.id);
      if (!result) throw new Error("Товар не найден");
      return result;
    },
  },
};
export function productUi(items = products, existing = false): UiMessage[] {
  const components: Record<string, unknown>[] = [
    {
      id: "root",
      component: "Column",
      children: [
        "heading",
        "search-field",
        "search-button",
        ...items.map((p) => `card-${p.id}`),
      ],
    },
    {
      id: "heading",
      component: "Text",
      text: "Демонстрационный каталог",
      variant: "h2",
    },
    {
      id: "search-field",
      component: "TextField",
      label: "Уточнить поиск",
      value: { path: "/query" },
    },
    { id: "search-label", component: "Text", text: "Обновить результаты" },
    {
      id: "search-button",
      component: "Button",
      child: "search-label",
      action: {
        event: {
          name: "search_products",
          context: { query: { path: "/query" } },
        },
      },
    },
  ];
  for (const p of items)
    components.push(
      {
        id: `card-${p.id}`,
        component: "Column",
        children: [`name-${p.id}`, `description-${p.id}`, `button-${p.id}`],
      },
      {
        id: `name-${p.id}`,
        component: "Text",
        text: `${p.name} · ${p.price} ₽`,
        variant: "h3",
      },
      { id: `description-${p.id}`, component: "Text", text: p.description },
      {
        id: `button-${p.id}`,
        component: "Button",
        child: `label-${p.id}`,
        action: {
          event: { name: "show_product", context: { productId: p.id } },
        },
      },
      { id: `label-${p.id}`, component: "Text", text: "Подробнее" },
    );
  return [
    ...(existing
      ? [
          {
            version: "v0.9.1" as const,
            deleteSurface: { surfaceId: "products" },
          },
        ]
      : []),
    {
      version: "v0.9.1",
      createSurface: { surfaceId: "products", catalogId: CATALOG_ID },
    },
    {
      version: "v0.9.1",
      updateComponents: { surfaceId: "products", components },
    },
  ];
}
