/**
 * `app/` — top protocol layer. AppHost, app registration, lease registry,
 * server boot, layer composition.
 *
 * Layer rules:
 *   - May import: kernels and every other protocol layer.
 *   - May NOT be imported by: any protocol layer (app is the composition root).
 *
 * Public surface: `createCoreApp`, `AppHost`, `LeaseRegistry`, all Tag and
 * Layer constructors from `layers.ts`, app-host handler registry.
 */
export {};
