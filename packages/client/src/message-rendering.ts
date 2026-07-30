import type { Part } from "@moltzap/protocol/message";
import { Match } from "effect";

/** Provides the render part runtime value. */
export const renderPart: (part: Part) => string = Match.type<Part>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (text) => text.text,
    image: () => "[image]",
    file: (file) => `[file: ${file.name}]`,
  }),
);
