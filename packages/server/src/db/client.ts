import type { Kysely } from "kysely";
import type { Database } from "./database.js";

export type Db = Kysely<Database>;
