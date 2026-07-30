/**
 * @file Narrowing guards for the reverse app-callback request union.
 *
 * One guard per app-callback method, keyed on the request's `definition`.
 * Shared by the server socket's reverse-callback dispatch and the test
 * endpoint builders so adding a callback method updates the guard set once.
 */

import { messagesAuthorize } from "#message";
import { taskCreate } from "#task";
import { dispatchAuthorize } from "#message/dispatch";
import type { ReverseCallbackRequest } from "./server.js";

/** Represents dispatch authorize request values. */
export type DispatchAuthorizeRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof dispatchAuthorize }
>;
/** Represents messages authorize request values. */
export type MessagesAuthorizeRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof messagesAuthorize }
>;
/** Represents task create request values. */
export type TaskCreateRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof taskCreate }
>;

/**
 * Provides the is dispatch authorize request runtime value.
 * @param request Value supplied to the operation.
 * @returns Whether dispatch authorize request.
 */
export const isDispatchAuthorizeRequest = (
  request: ReverseCallbackRequest,
): request is DispatchAuthorizeRequest =>
  request.definition === dispatchAuthorize;

/**
 * Provides the is messages authorize request runtime value.
 * @param request Value supplied to the operation.
 * @returns Whether messages authorize request.
 */
export const isMessagesAuthorizeRequest = (
  request: ReverseCallbackRequest,
): request is MessagesAuthorizeRequest =>
  request.definition === messagesAuthorize;

/**
 * Provides the is task create request runtime value.
 * @param request Value supplied to the operation.
 * @returns Whether task create request.
 */
export const isTaskCreateRequest = (
  request: ReverseCallbackRequest,
): request is TaskCreateRequest => request.definition === taskCreate;
