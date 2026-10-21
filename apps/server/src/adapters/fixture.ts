import type { Adapter } from "./types.ts";
import { productUi } from "../tools.ts";
import type { products } from "../tools.ts";
export const fixtureAdapter: Adapter = {
  kind: "agent",
  async run(context, callTool, signal) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 150);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
    if (signal.aborted) throw signal.reason;
    const action = context.run.input.action;
    const items =
      action?.name === "search_products"
        ? await callTool(
            "search_products",
            { query: String(action.context.query ?? "") },
            "fixture-form",
          )
        : action
          ? [
              await callTool(
                "get_product",
                { id: action.context.productId },
                "fixture-detail",
              ),
            ]
          : await callTool(
              "search_products",
              {
                warm: /тёпл|тепл/.test(context.run.input.text ?? ""),
                compact: /компакт/.test(context.run.input.text ?? ""),
              },
              "fixture-search",
            );
    return {
      text: "Демонстрационные данные. Ответ сформирован тестовым адаптером.",
      a2uiJson: JSON.stringify(
        productUi(
          items as typeof products,
          context.dialog.ui.messages.length > 0,
        ),
      ),
    };
  },
};
