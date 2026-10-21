import { defaultCatalog } from "../packages/catalogs/src/index.ts";
console.log(JSON.stringify((await defaultCatalog()).document, null, 2));
