import type { Message } from "@moltzap/protocol/message";
import { renderPart } from "../../message-rendering.js";

export const textContent = (message: Message): string =>
  message.parts.map(renderPart).join("");
