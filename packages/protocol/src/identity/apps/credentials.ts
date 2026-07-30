import { Schema, type Brand, type Redacted } from "effect";

const APP_KEY_PREFIX = "moltzap_app_";
const KEY_ID_HEX_CHARS = 16;
const SECRET_HEX_CHARS = 48;
const KEY_ID_HEX_PATTERN = `[0-9a-f]{${KEY_ID_HEX_CHARS}}`;
const SECRET_HEX_PATTERN = `[0-9a-f]{${SECRET_HEX_CHARS}}`;

type AppKeyValue = string & Brand.Brand<"AppKey">;
const appKeyValue: Schema.Schema<AppKeyValue, string> = Schema.String.pipe(
  Schema.pattern(
    new RegExp(
      `^${APP_KEY_PREFIX}${KEY_ID_HEX_PATTERN}_${SECRET_HEX_PATTERN}$`,
    ),
  ),
  Schema.brand("AppKey"),
  Schema.annotations({ description: "MoltZap app API key" }),
);

/** Represents app key values. */
export type AppKey = Redacted.Redacted<AppKeyValue>;
/** Validates and decodes app key values. */
export const appKey: Schema.Schema<AppKey, string> =
  Schema.Redacted(appKeyValue);
