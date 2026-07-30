/** @file Encryption service tag. */

import { Context } from "effect";

import type { EnvelopeEncryption } from "./envelope.js";

/** Implements encryption tag. */
export class EncryptionTag extends Context.Tag("moltzap/Encryption")<
  EncryptionTag,
  EnvelopeEncryption | null
>() {}
