import type { Message } from "@moltzap/protocol";
import { renderPart } from "../../runtime/service-helpers.js";

export const textContent = (message: Message): string =>
  message.parts.map(renderPart).join("");
