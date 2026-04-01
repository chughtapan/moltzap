#!/usr/bin/env bash
set -euo pipefail

# Pack server-core into a tarball
TARBALL=$(cd packages/server-core && pnpm pack --pack-destination /tmp 2>/dev/null | tail -1)
echo "Packed: $TARBALL"

# Create temp project
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

cd "$TMPDIR"
cat > package.json << 'PKGJSON'
{ "name": "test-consumer", "type": "module", "private": true }
PKGJSON

cat > tsconfig.json << 'TSCONF'
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022",
    "strict": true,
    "noEmit": true
  }
}
TSCONF

# Install the tarball + peer deps
npm install "$TARBALL" @moltzap/protocol@latest kysely@latest pg@latest hono@latest @hono/node-server@latest @hono/node-ws@latest pino@latest @types/pg@latest typescript@latest 2>&1 | tail -3

# Write a consumer that imports key building blocks
cat > consumer.ts << 'CONSUMER'
import {
  AuthService,
  ConversationService,
  MessageService,
  ParticipantService,
  PresenceService,
  DeliveryService,
  createRpcRouter,
  RpcError,
  ConnectionManager,
  Broadcaster,
  EnvelopeEncryption,
  seedInitialKek,
  generateApiKey,
  logger,
  defineMethod,
  createDb,
  nextSnowflakeId,
  snowflakeToTimestamp,
} from "@moltzap/server-core";
import type { Database, Db, AuthenticatedContext, RpcMethodDef } from "@moltzap/server-core";

// Verify classes are constructable (type-level only)
type _check1 = ConstructorParameters<typeof AuthService>;
type _check2 = ConstructorParameters<typeof PresenceService>;
type _check3 = typeof createRpcRouter;
type _check4 = typeof generateApiKey;

console.log("All imports resolved successfully");
CONSUMER

# Compile — this catches missing exports, broken type declarations
./node_modules/.bin/tsc --noEmit 2>&1
echo "PASS: Pack + install + compile succeeded"
