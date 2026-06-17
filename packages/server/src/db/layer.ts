/** @file Database service tag. */

import { Context } from "effect";

import type { Db } from "./client.js";

export class DbTag extends Context.Tag("moltzap/Db")<DbTag, Db>() {}
