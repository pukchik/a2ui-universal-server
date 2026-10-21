import { Store } from "./storage/store.ts";
if (!process.env.DATABASE_URL) throw new Error("Укажите DATABASE_URL");
const store = new Store(process.env.DATABASE_URL);
try {
  await store.migrate();
  console.log("Миграции применены");
} finally {
  await store.close();
}
