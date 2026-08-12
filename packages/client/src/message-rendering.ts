/**
 * @file Exhaustive plain-text projection of protocol message parts for
 * endpoint context summaries.
 */

import type { Part } from "@moltzap/protocol/message";
import { Match } from "effect";

/** Preserves text while giving non-text parts stable, compact placeholders. */
export const renderPart: (part: Part) => string = Match.type<Part>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (text) => text.text,
    image: () => "[image]",
    file: (file) => `[file: ${file.name}]`,
  }),
);
