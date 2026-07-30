import type { Kysely } from "kysely";
import type { Database } from "./database.js";

/** Represents db values. */
export type Db = Kysely<Database>;
