// app/ — app-host, lease registry, dispatch admission, server boot.
//
// Public barrel for the app layer (top of stack). Pre-2A.2: app/
// already holds app-host, layers, server, hooks, dev, types,
// conversation-app-lookup, lease-registry, config, handlers/. The
// Phase 2A.1 skeleton adds this barrel + README without moving files;
// Phase 2A.2 leaves app/ contents in place (minimal change per parent
// epic mapping).

export {};
