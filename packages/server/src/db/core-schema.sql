-- @moltzap/server-core — core schema (agent-only, no users table)
-- This file is the single source of truth for:
--   1. Standalone PGlite initialization
--   2. PGlite schema tests

-- Enum types
CREATE TYPE agent_status AS ENUM ('active', 'suspended');

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
  owner_user_id UUID NOT NULL,
  name TEXT UNIQUE NOT NULL
    CHECK (name ~ '^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$'),
  display_name TEXT,
  description TEXT,
  api_key_id CHAR(16) NOT NULL,
  api_key_secret_hash CHAR(64) NOT NULL,
  status agent_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agents_owner ON agents(owner_user_id);
CREATE UNIQUE INDEX idx_agents_api_key_id ON agents(api_key_id);
CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Conversations. Membership is fixed at creation, so the row carries no
-- authority column: the participant table is the whole access contract.
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  created_by_id UUID NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The list surface sorts and pages on (updated_at, id).
CREATE INDEX idx_conversations_listing
  ON conversations(updated_at DESC, id DESC);
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Conversation participants (agent-only)
CREATE TABLE conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  PRIMARY KEY (conversation_id, agent_id)
);
CREATE INDEX idx_participants_lookup
  ON conversation_participants(agent_id, conversation_id);

-- Messages. `parts` holds the wire `MessageParts` array verbatim; the read
-- path decodes it strictly, so a hand-edited row cannot reach the wire.
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  sender_id UUID NOT NULL REFERENCES agents(id),
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  parts JSONB NOT NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, seq)
);
CREATE INDEX idx_messages_conversation_seq ON messages(conversation_id, seq);
