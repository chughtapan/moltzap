import type { Hono } from "hono";
import type { RpcMethodDef } from "../rpc/context.js";
import type { AppManifest, AppSession } from "@moltzap/protocol";
import type { ContactChecker, PermissionHandler } from "./app-host.js";
import type {
  BeforeMessageDeliveryHook,
  OnCloseHook,
  OnJoinHook,
} from "./hooks.js";

export interface CoreConfig {
  databaseUrl: string;
  encryptionMasterSecret: string;
  port: number;
  corsOrigins: string[];
  devMode?: boolean;
}

export type ConnectionHook = (params: {
  agentId: string;
  agentName: string;
  connId: string;
}) => Promise<void> | void;

export interface CoreApp {
  app: Hono;
  readonly port: number;
  registerRpcMethod: (name: string, def: RpcMethodDef) => void;
  onConnection: (hook: ConnectionHook) => void;
  registerApp: (manifest: AppManifest) => void;
  setContactChecker: (checker: ContactChecker) => void;
  setPermissionHandler: (handler: PermissionHandler) => void;
  createAppSession: (
    appId: string,
    initiatorAgentId: string,
    invitedAgentIds: string[],
  ) => Promise<AppSession>;
  onBeforeMessageDelivery: (
    appId: string,
    handler: BeforeMessageDeliveryHook,
  ) => void;
  onAppJoin: (appId: string, handler: OnJoinHook) => void;
  onAppClose: (appId: string, handler: OnCloseHook) => void;
  closeAppSession: (
    sessionId: string,
    callerAgentId: string,
  ) => Promise<{ closed: true }>;
  close: () => Promise<void>;
}
