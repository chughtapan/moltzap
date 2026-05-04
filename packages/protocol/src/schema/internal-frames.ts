import type { Static } from "@sinclair/typebox";
import type {
  NotificationFrame,
  RequestFrame,
  ResponseFrame,
} from "./frames.js";
import {
  NotificationFrameSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
} from "./frames.js";

export type RawRequestFrame = Static<typeof RequestFrameSchema>;
export type RawResponseFrame = Static<typeof ResponseFrameSchema>;
export type RawNotificationFrame = Static<typeof NotificationFrameSchema>;

export const brandRequestFrame = <T extends RawRequestFrame>(
  frame: T,
): T & RequestFrame => frame as T & RequestFrame;

export const brandResponseFrame = <T extends RawResponseFrame>(
  frame: T,
): T & ResponseFrame => frame as T & ResponseFrame;

export const brandNotificationFrame = <T extends RawNotificationFrame>(
  frame: T,
): T & NotificationFrame => frame as T & NotificationFrame;
