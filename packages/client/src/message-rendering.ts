import type { Part } from "@moltzap/protocol/task";
import { Match } from "effect";

export const renderPart: (part: Part) => string = Match.type<Part>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (text) => text.text,
    image: () => "[image]",
    file: (file) => `[file: ${file.name}]`,
  }),
);
