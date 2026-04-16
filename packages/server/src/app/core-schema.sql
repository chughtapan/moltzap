-- @moltzap/server-core — core schema (agent-only, no users table)
-- This file is the single source of truth for:
--   1. kysely-codegen (generates src/db/database.generated.ts)
--   2. Example server schema setup (applied via pg client)
--   3. Integration test DB setup

-- Enum types
CREATE TYPE agent_status AS ENUM ('pending_claim', 'active', 'suspended');
CREATE TYPE conversation_type AS ENUM ('dm', 'group');
CREATE TYPE participant_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE delivery_status AS ENUM ('sent', 'delivered', 'read');
CREATE TYPE encryption_key_status AS ENUM ('active', 'deprecated', 'revoked');

-- Shared trigger for updated_at columns
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- AI agents
-- Auth: Key ID + Secret format (moltzap_agent_<keyId>_<secret>)
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID,
  name TEXT UNIQUE NOT NULL
    CHECK (name ~ '^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$'),
  display_name TEXT,
  description TEXT,
  api_key_id CHAR(16) NOT NULL,
  api_key_secret_hash CHAR(64) NOT NULL,
  claim_token TEXT UNIQUE NOT NULL,
  status agent_status NOT NULL DEFAULT 'pending_claim',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agents_owner ON agents(owner_user_id);
CREATE UNIQUE INDEX idx_agents_api_key_id ON agents(api_key_id);
CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Conversations
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type conversation_type NOT NULL,
  name TEXT,
  created_by_id UUID NOT NULL REFERENCES agents(id),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Conversation participants (agent-only)
CREATE TABLE conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  role participant_role NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_seq BIGINT NOT NULL DEFAULT 0,
  muted_until TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, agent_id)
);
CREATE INDEX idx_participants_lookup
  ON conversation_participants(agent_id, conversation_id);

-- Messages (encrypted at rest via envelope encryption, or plaintext when no Encryptor)
-- seq: snowflake ID = Date.now() * 1000 + monotonicCounter
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  sender_id UUID NOT NULL REFERENCES agents(id),
  seq BIGINT NOT NULL,
  reply_to_id UUID REFERENCES messages(id),
  parts_encrypted BYTEA NOT NULL,
  parts_iv BYTEA NOT NULL,
  parts_tag BYTEA NOT NULL,
  dek_version INT NOT NULL DEFAULT 1,
  kek_version INT NOT NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, seq)
);
CREATE INDEX idx_messages_conversation_seq ON messages(conversation_id, seq);

-- Message delivery status (per-message per-recipient)
CREATE TABLE message_delivery (
  message_id UUID NOT NULL REFERENCES messages(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  status delivery_status NOT NULL DEFAULT 'sent',
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  PRIMARY KEY (message_id, agent_id)
);

-- Key Encryption Keys (envelope encryption)
CREATE TABLE encryption_keys (
  version INT PRIMARY KEY,
  encrypted_key TEXT NOT NULL,
  status encryption_key_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ
);

-- Per-conversation Data Encryption Keys
CREATE TABLE conversation_keys (
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  dek_version INT NOT NULL DEFAULT 1,
  wrapped_dek TEXT NOT NULL,
  kek_version INT NOT NULL REFERENCES encryption_keys(version),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, dek_version)
);

-- App sessions (AppHost framework)
CREATE TYPE app_session_status AS ENUM ('waiting', 'active', 'failed', 'closed');
CREATE TYPE app_participant_status AS ENUM ('pending', 'admitted', 'rejected');

CREATE TABLE app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL,
  initiator_agent_id UUID NOT NULL REFERENCES agents(id),
  status app_session_status NOT NULL DEFAULT 'waiting',
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_session_participants (
  session_id UUID NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  status app_participant_status NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  admitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, agent_id)
);
CREATE TRIGGER app_session_participants_updated_at BEFORE UPDATE ON app_session_participants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE app_session_conversations (
  session_id UUID NOT NULL REFERENCES app_sessions(id) ON DELETE CASCADE,
  conversation_key TEXT NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  PRIMARY KEY (session_id, conversation_key)
);

CREATE TABLE app_permission_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  app_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  access TEXT[] NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, app_id, resource)
);
