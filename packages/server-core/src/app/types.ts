import type { Hono } from "hono";
import type { RpcMethodDef } from "../rpc/context.js";

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
  close: () => Promise<void>;
}
