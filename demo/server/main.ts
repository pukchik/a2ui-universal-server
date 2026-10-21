import { configFrom } from "./config.ts";
import { startServer } from "../../server/index.ts";
import { demoOptions } from "./app.ts";
const config = configFrom(process.env);
await startServer(config, { ...demoOptions(config), logger: true });
