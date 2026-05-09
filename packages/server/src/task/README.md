# task/

Task lifecycle, conversations, messages, archive. Owns the
"what work is happening" surface — distinct from app/ which owns
"who runs the work."

## Folder shape (peers under task/)

```
task/
  handlers/       # RPC handlers (conversations, messages, presence, contacts, tasks)
  services/       # conversation, message, task, default-tm (post-2A.2)
  index.ts        # barrel
  README.md
```

Per Q-task-folder-shape resolution: handlers/ and services/ are peers
of task/index.ts.

## Existing contents (pre-Phase-2A.2)

### `task/handlers/`
- `conversations.handlers.ts`
- `messages.handlers.ts`
- `presence.handlers.ts` (+ test)
- `contacts.handlers.ts` (architect disposition: stays in task/handlers/
  since it routes through the TM message bus today; revisit during
  Phase 2B if integration tests reveal a cleaner home).
- `tasks.handlers.ts`

## Post-Phase-2A.2 additions

### `task/services/` (new sub-folder)
- `conversation.service.ts` (from `services/`)
- `message.service.ts` (from `services/`)
- `task.service.ts` (from `services/`)
- `default-tm.ts` (from `services/`)

## Public surface

`@moltzap/server-core/task` re-exports the task layer's symbols.

## Import policy

| From  | To                                       | Allowed?                |
|-------|------------------------------------------|-------------------------|
| task  | network, identity, transport, _infra     | Yes                     |
| task  | app                                      | NO (downward only)      |
| app   | task                                     | Yes (via subpath import)|
