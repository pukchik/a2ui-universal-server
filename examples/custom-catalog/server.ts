import { createCatalogProfile } from "../../server/index.ts";
import { document, modelCatalog } from "./model.ts";
export const statusProfile = await createCatalogProfile(document, modelCatalog);
// Pass catalogs: [statusProfile] to startServer; the first profile is the default.
