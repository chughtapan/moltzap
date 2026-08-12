/** @file Database service tag. */

import { Context } from "effect";

import type { Db } from "./database.js";

/** Implements db tag. */
export class DbTag extends Context.Tag("moltzap/Db")<DbTag, Db>() {}
