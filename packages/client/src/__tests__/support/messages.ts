import type { Message } from "@moltzap/protocol/message";
import { renderPart } from "../../message-rendering.js";

/**
 * Provides the text content runtime value.
 * @param message Value supplied to the operation.
 * @returns The text content result.
 */
export const textContent = (message: Message): string =>
  message.parts.map(renderPart).join("");
