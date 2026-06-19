/**
 * @file Narrowing guards for the reverse app-callback request union.
 *
 * One guard per app-callback method, keyed on the request's `definition`.
 * Shared by the server socket's reverse-callback dispatch and the test
 * endpoint builders so adding a callback method updates the guard set once.
 */

import { MessagesAuthorize } from "#message";
import { TaskCreate } from "#task";
import { DispatchAuthorize } from "#message/dispatch";
import type { ReverseCallbackRequest } from "./server.js";

export type DispatchAuthorizeRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof DispatchAuthorize }
>;
export type MessagesAuthorizeRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof MessagesAuthorize }
>;
export type TaskCreateRequest = Extract<
  ReverseCallbackRequest,
  { readonly definition: typeof TaskCreate }
>;

export const isDispatchAuthorizeRequest = (
  request: ReverseCallbackRequest,
): request is DispatchAuthorizeRequest =>
  request.definition === DispatchAuthorize;

export const isMessagesAuthorizeRequest = (
  request: ReverseCallbackRequest,
): request is MessagesAuthorizeRequest =>
  request.definition === MessagesAuthorize;

export const isTaskCreateRequest = (
  request: ReverseCallbackRequest,
): request is TaskCreateRequest => request.definition === TaskCreate;
