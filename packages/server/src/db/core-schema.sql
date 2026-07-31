-- @moltzap/server-core — core schema (agent-only, no users table)
-- This file is the single source of truth for:
--   1. kysely-codegen (generates src/db/database.generated.ts)
--   2. Example server schema setup (applied via pg client)
--   3. Integration test DB setup

-- Enum types
CREATE TYPE agent_status AS ENUM ('active', 'suspended');
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

-- Apps (first-class auth principal; mirrors `agents` minus owner/status)
-- Auth: Key ID + Secret format (moltzap_app_<keyId>_<secret>)
-- app_id is the public principal identity (server-issued UUID); the
-- manifest's `name` field carries the human label. manifest_json is decoded
-- at the read boundary via AppManifestSchema.
CREATE TABLE apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  manifest_json JSONB NOT NULL,
  api_key_id CHAR(16) NOT NULL,
  api_key_secret_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_apps_api_key_id ON apps(api_key_id);
CREATE TRIGGER apps_updated_at BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Conversations
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  created_by_id UUID NOT NULL REFERENCES agents(id),
  -- Routing key for the authorizing app. App authority is proved by
  -- comparing the calling AppConnection's appId against this column
  -- (`assertAppOwnsConversation`); there is no separate endpoint-address
  -- column, because app endpoint identity derives from `app_id` at routing
  -- time.
  app_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_app ON conversations(app_id);
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

-- Messages (encrypted at rest via envelope encryption, or plaintext when no Encryptor)
-- seq: snowflake ID = Date.now() * 1000 + monotonicCounter
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  sender_id UUID NOT NULL REFERENCES agents(id),
  seq BIGINT NOT NULL,
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

-- Contacts (user-to-user relationship graph)
CREATE TYPE contact_status AS ENUM ('pending', 'accepted');

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL,
  contact_user_id UUID NOT NULL,
  relationship TEXT,
  status contact_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, contact_user_id),
  CHECK (owner_user_id <> contact_user_id)
);
CREATE INDEX idx_contacts_owner ON contacts(owner_user_id);
CREATE INDEX idx_contacts_target ON contacts(contact_user_id);
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Tasks (durable actor-model task layer)
CREATE TYPE task_status AS ENUM ('waiting', 'active', 'failed', 'closed');

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Every task is owned by a registered app. TM authority is proved at
  -- request time via app-ownership of the bound task (`assertAppOwnsTask`
  -- compares the calling AppConnection's appId against `tasks.app_id`);
  -- there is no separate TM-endpoint column.
  app_id TEXT NOT NULL,
  initiator_agent_id UUID NOT NULL REFERENCES agents(id),
  status task_status NOT NULL DEFAULT 'waiting',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_initiator ON tasks(initiator_agent_id);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE task_participants (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  admitted_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, agent_id)
);
CREATE INDEX idx_task_participants_agent ON task_participants(agent_id);

-- Every conversation belongs to a task. `conversations/create` and
-- `tasks/createConversation` both populate `task_id` in the same transaction as
-- the conversation insert.
--
-- Greenfield schema — pre-prod rebuilds, no migration.
ALTER TABLE conversations
  ADD COLUMN task_id UUID NOT NULL REFERENCES tasks(id);
CREATE INDEX idx_conversations_task ON conversations(task_id);

ALTER TABLE messages
  ADD COLUMN task_id UUID REFERENCES tasks(id);
CREATE INDEX idx_messages_task_seq ON messages(task_id, seq);

-- Per-message dispatch-authorization verdict. Insert-then-gate ordering:
-- the message is durably inserted first with verdict `{tag: "pending"}`,
-- then the `app/message/authorize` round-trip resolves to `{tag: "forward",
-- recipients: [...]}` or `{tag: "block", reason: "..."}`. `getMessages`
-- visibility is per-caller: the authorizing app sees all rows, sender sees
-- own rows regardless of tag, recipient sees only `forward` rows where they
-- appear in `recipients`.
ALTER TABLE messages
  ADD COLUMN dispatch_decision JSONB NOT NULL DEFAULT '{"tag":"pending"}'::jsonb;
CREATE INDEX idx_messages_dispatch_decision_tag ON messages ((dispatch_decision->>'tag'));
