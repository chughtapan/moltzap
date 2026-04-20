-- Migration 0001 — layered-tasks schema (spec #136, slice B).
--
-- This is a destructive migration. The project is pre-production and the
-- spec (#134, #136) explicitly authorizes dropping existing rows. No backfill.
--
-- This file is the migration skeleton — operations are named but bodies are
-- filled in by the implement-* downstream modality.
--
-- Scope note (spec #136 invariant 3): the task layer carries NO DM-specific
-- schema. There is no `participant_set_hash` column, no `participant_count`
-- column, and no partial unique index for DM uniqueness. DM uniqueness and
-- immutability live in the default DM task manager (spec #137), which
-- enforces them via SELECT-before-INSERT against the task layer's read
-- methods (getTask / listParticipants).

-- === 1. DROP existing tables / types =====================================
-- Drop app_session_conversations, app_session_participants, app_sessions
-- (slice B removes the session concept — a session IS a task).
-- Drop message_delivery, messages, conversation_keys, conversation_participants,
-- conversations in dependency order.
-- Drop the `conversation_type` enum.

-- === 2. CREATE task_status enum ==========================================
-- Values: 'active', 'closed'.

-- === 3. CREATE tasks table ===============================================
-- Columns (spec goal 1 — identity + lifecycle only; no DM-specific columns):
--   id UUID PK
--   status task_status NOT NULL DEFAULT 'active'
--   started_at TIMESTAMPTZ NOT NULL DEFAULT now()
--   ended_at TIMESTAMPTZ NULL
--   app_id TEXT NULL                              -- NULL for non-app tasks
--   initiator_agent_id UUID NOT NULL REFERENCES agents(id)
-- No participant_count, no participant_set_hash, no conversation_count.
-- participant_count is computed at read time from task_participants when
-- getTask / listParticipants need it.

-- === 4. CREATE task_participants table ===================================
-- (task_id, agent_id) PK; FK to tasks and agents.

-- === 5. (intentionally empty) ============================================
-- No partial unique index for DM uniqueness at the task layer. DM
-- idempotence is enforced by the DM task manager (spec #137).

-- === 6. CREATE conversations table =======================================
-- Columns (spec goal 2 — keyed by (task_id, id); no `type` field):
--   task_id UUID NOT NULL REFERENCES tasks(id)
--   id UUID NOT NULL
--   name TEXT NULL
--   created_by_id UUID NOT NULL REFERENCES agents(id)
--   archived_at TIMESTAMPTZ NULL
--   created_at / updated_at TIMESTAMPTZ
-- PRIMARY KEY (task_id, id).
-- The composite PK binds every conversation to its owning task; the message
-- table's composite FK on (task_id, conversation_id) then makes cross-task
-- references structurally unrepresentable.

-- === 7. CREATE messages table ============================================
-- Columns (spec goal 3):
--   id UUID PK
--   task_id UUID NOT NULL                         -- part of composite FK
--   conversation_id UUID NOT NULL                 -- part of composite FK
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
-- FOREIGN KEY (task_id, conversation_id) REFERENCES conversations(task_id, id).
-- Indexes: (task_id, seq), (conversation_id, seq), UNIQUE(conversation_id, seq).

-- === 8. RECREATE message_delivery, conversation_keys =====================
-- Shape unchanged from core-schema.sql; re-created pointing at new tables.

-- === 9. Update triggers ==================================================
-- Attach update_updated_at trigger to tasks, conversations.

-- End of migration 0001.
