import type { Hono } from "hono";
import type { RpcMethodDef } from "../rpc/context.js";
import type { AppManifest, AppSession } from "@moltzap/protocol";
import type { ContactService, PermissionService } from "./app-host.js";
import type { UserService } from "../services/user.service.js";
import type { BeforeMessageDeliveryHook, OnJoinHook } from "./hooks.js";

export interface ServiceConfig {
  type: "webhook" | "in_process";
  webhook_url?: string;
  timeout_ms?: number;
  callback_token?: string;
}

export interface CoreConfig {
  databaseUrl: string;
  encryptionMasterSecret?: string;
  port: number;
  corsOrigins: string[];
  devMode?: boolean;
  logLevel?: "debug" | "info" | "warn" | "error";
  services?: {
    users?: ServiceConfig;
    contacts?: ServiceConfig;
    permissions?: ServiceConfig;
  };
  registration?: {
    secret?: string;
  };
  seed?: {
    agents?: Array<{ name: string; description?: string }>;
    onboarding_message?: string;
  };
  apps?: Array<{ manifest: string }>;
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
  setUserService: (service: UserService) => void;
  setContactService: (checker: ContactService) => void;
  setPermissionService: (handler: PermissionService) => void;
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
  close: () => Promise<void>;
}
