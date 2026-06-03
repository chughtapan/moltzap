import {
  identityRpcMethods,
  identityNotifications,
} from "./identity/methods.js";
import { networkRpcMethods, networkNotifications } from "./network/methods.js";
import {
  taskRpcMethods,
  taskNotifications,
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
} from "./task/methods.js";
import {
  appRpcMethods,
  appCallbackMethods,
  appNotifications,
} from "./app/methods.js";
import type { RpcDefinition } from "./transport/method.js";

export { appCallbackMethods };

// Per-kind outbound catalogs.
//   `agentClientRpcMethods` — callable from `MoltZapAgentClient`.
//   `appCallableRpcMethods`  — superset; adds app-only operations.
//   `serverRpcMethods`      — server inbound; full union.
export const agentClientRpcMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...agentCallableTaskRpcMethods,
  ...appRpcMethods,
] as const;

export const appCallableRpcMethods = [
  ...agentClientRpcMethods,
  ...appCallableTaskRpcMethods,
] as const;

export const serverRpcMethods = [
  ...identityRpcMethods,
  ...networkRpcMethods,
  ...taskRpcMethods,
  ...appRpcMethods,
] as const;

export const notificationDefinitions = [
  ...networkNotifications,
  ...identityNotifications,
  ...taskNotifications,
  ...appNotifications,
] as const;

export type AnyServerRpcDefinition = (typeof serverRpcMethods)[number] &
  RpcDefinition<string, any, any>;
export type AnyAgentClientRpcDefinition =
  (typeof agentClientRpcMethods)[number] & RpcDefinition<string, any, any>;

export type AnyAppCallbackRpcDefinition = (typeof appCallbackMethods)[number];

export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];
