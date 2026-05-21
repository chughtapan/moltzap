-- @moltzap/server-core — core schema (agent-only, no users table)
-- This file is the single source of truth for:
--   1. kysely-codegen (generates src/db/database.generated.ts)
--   2. Example server schema setup (applied via pg client)
--   3. Integration test DB setup

-- Enum types
CREATE TYPE agent_status AS ENUM ('pending_claim', 'active', 'suspended');
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
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_seq BIGINT NOT NULL DEFAULT 0,
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

-- Message-delivery tracking (table `message_delivery`, enum `delivery_status`)
-- dropped in Phase 7.5 (sub-issue #450). Per-message per-recipient
-- sent/delivered/read state was server-side audit debt: zero internal
-- consumers, no external API surface, the synchronous network.send
-- ack-channel that lands in Phase 8 covers "did it deliver" semantics
-- end-to-end without persistence.

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

-- App sessions: dropped in Phase 7 (B+E cutover, sub-issue #425). The
-- `tasks/task_participants` schema below + `conversations.task_id` (added
-- in Phase 5) is the durable replacement; `apps/createSession`-style
-- wire RPCs are deleted in favour of `tasks/*` (Phase 6).

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
  app_id TEXT,
  initiator_agent_id UUID NOT NULL REFERENCES agents(id),
  status task_status NOT NULL DEFAULT 'waiting',
  -- Phase 9b consumer-migration (sub-issue #460 round 3 R12): NOT NULL.
  -- Every task carries a registered TM at insert time. The pre-Phase-9b
  -- two-step (`tasks/create` then `endpoints/registerTaskManager`)
  -- collapsed to one transaction; `endpoints/{,un}registerTaskManager`
  -- wire RPCs retired with the schema constraint.
  --
  -- Round 4 R18 (codex HIGH-C): the schema is greenfield. Pre-prod
  -- deployments rebuild the DB on every deploy — there is no in-place
  -- upgrade path for the NOT NULL flip and no migration script
  -- accompanies it. Future production cutover (Phase 11+) needs an
  -- explicit migration framework before this column can be backfilled.
  tm_endpoint_address TEXT NOT NULL,
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

-- Phase 9b consumer-migration (sub-issue #460 round 3 R12): NOT NULL.
-- Every conversation belongs to a task. `conversations/create` and
-- `tasks/createConversation` both populate `task_id` in the same
-- transaction as the conversation insert; the pre-R12 path that
-- created task-less conversations retired alongside the broadcast
-- fallback in `MessageService.send`.
--
-- Round 4 R18 (codex HIGH-C): greenfield schema. See the comment at
-- `tasks.tm_endpoint_address` above — pre-prod rebuilds, no migration.
ALTER TABLE conversations
  ADD COLUMN task_id UUID NOT NULL REFERENCES tasks(id);
CREATE INDEX idx_conversations_task ON conversations(task_id);

ALTER TABLE messages
  ADD COLUMN task_id UUID REFERENCES tasks(id);
CREATE INDEX idx_messages_task_seq ON messages(task_id, seq);

-- #560: per-message TM fan-out verdict. Insert-then-gate ordering
-- (#560 §7) — the message is durably inserted first with verdict
-- `{tag: "pending"}`, then the TM round-trip resolves to `{tag:
-- "forward", recipients: [...]}` or `{tag: "block", reason: "..."}`.
-- `getMessages` visibility is per-caller (architect plan §3 + §8):
-- TM sees all rows, sender sees own rows regardless of tag, recipient
-- sees only `forward` rows where they appear in `recipients`.
-- Greenfield schema follows the project's existing pattern (no
-- migration runner; column lands in `core-schema.sql` directly).
ALTER TABLE messages
  ADD COLUMN tm_decision JSONB NOT NULL DEFAULT '{"tag":"pending"}'::jsonb;
CREATE INDEX idx_messages_tm_decision_tag ON messages ((tm_decision->>'tag'));
