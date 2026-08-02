# Server integration tests

Per-layer organization mirrors the server socket / identity / messaging
decomposition.

## Layout

```
__tests__/integration/
├── socket/      # WebSocket lifecycle, heartbeat, reconnection
├── identity/    # registration, agents-list, auth
└── messaging/   # conversations, messages, trace spans
```

`helpers.ts` lives at this directory's root; tests under a layer subdir import
it via `../helpers.js`.

## Naming

Each file is `<scenario>.test.ts`; the layer subdir provides the test context.

The vitest discovery glob `src/__tests__/integration/**/*.test.ts`
(`vitest.integration.config.mjs`) reaches every subdir.
