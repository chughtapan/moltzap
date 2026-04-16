import { Context } from "effect";
import { PresenceService } from "../services/presence.service.js";

export class Presence extends Context.Tag("Presence")<
  Presence,
  PresenceService
>() {}
