-- Migration 0001 — layered-tasks schema (spec #136, slice B).
--
-- This is a destructive migration. The project is pre-production and the
-- spec (#134, #136) explicitly authorizes dropping existing rows. No backfill.
--
-- This file is the migration skeleton — operations are named but bodies are
-- filled in by the implement-* downstream modality.

-- === 1. DROP existing tables / types =====================================
-- Drop app_session_conversations, app_session_participants, app_sessions
-- (slice B removes the session concept — a session IS a task).
-- Drop message_delivery, messages, conversation_keys, conversation_participants,
-- conversations in dependency order.
-- Drop the `conversation_type` enum (participant_count replaces it).

-- === 2. CREATE task_status enum ==========================================
-- Values: 'active', 'closed'.

-- === 3. CREATE tasks table ===============================================
-- Columns (spec goal 1):
--   id UUID PK
--   status task_status NOT NULL DEFAULT 'active'
--   started_at TIMESTAMPTZ NOT NULL DEFAULT now()
--   ended_at TIMESTAMPTZ NULL
--   app_id TEXT NULL                              -- NULL for plain DM / group
--   initiator_agent_id UUID NOT NULL REFERENCES agents(id)
--   participant_count INT NOT NULL                -- denormalized
--   participant_set_hash CHAR(64) NOT NULL        -- sha256 hex, denormalized
--   conversation_count INT NOT NULL DEFAULT 0     -- needed for DM-shape guard

-- === 4. CREATE task_participants table ===================================
-- (task_id, agent_id) PK; FK to tasks and agents.

-- === 5. CREATE partial unique index on tasks =============================
-- CREATE UNIQUE INDEX idx_tasks_dm_uniqueness
--   ON tasks (participant_set_hash)
--   WHERE app_id IS NULL AND participant_count = 2;
-- Enforces spec AC 3 at the DB level.

-- === 6. CREATE conversations table =======================================
-- Columns (spec goal 2 — no `type` field):
--   id UUID PK
--   task_id UUID NOT NULL REFERENCES tasks(id)
--   name TEXT NULL
--   created_by_id UUID NOT NULL REFERENCES agents(id)
--   archived_at TIMESTAMPTZ NULL
--   created_at / updated_at TIMESTAMPTZ

-- === 7. CREATE messages table ============================================
-- Columns (spec goal 3):
--   id UUID PK
--   task_id UUID NOT NULL REFERENCES tasks(id)    -- denormalized
--   conversation_id UUID NOT NULL REFERENCES conversations(id)
--   sender_id UUID NOT NULL REFERENCES agents(id)
--   seq BIGINT NOT NULL
--   reply_to_id UUID NULL REFERENCES messages(id)
--   parts_encrypted BYTEA NOT NULL
--   parts_iv BYTEA NOT NULL
--   parts_tag BYTEA NOT NULL
--   dek_version INT NOT NULL
--   kek_version INT NOT NULL
--   is_deleted BOOLEAN NOT NULL DEFAULT false
--   created_at TIMESTAMPTZ NOT NULL DEFAULT now()
-- Indexes: (task_id, seq), (conversation_id, seq), UNIQUE(conversation_id, seq).

-- === 8. RECREATE message_delivery, conversation_keys =====================
-- Shape unchanged from core-schema.sql; re-created pointing at new tables.

-- === 9. Update triggers ==================================================
-- Attach update_updated_at trigger to tasks, conversations.

-- End of migration 0001.
