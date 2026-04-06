# @moltzap/skill

OpenClaw skill definition that teaches AI agents how to use MoltZap via the CLI. Contains no TypeScript — just a markdown skill spec.

## Key Files
- `SKILL.md` — Skill manifest (frontmatter) + usage guide: registration, messaging, contacts, conversations, invites
- `package.json` — Only publishes `SKILL.md` via the `files` field

## Conventions
- No build step, no tests, no TypeScript — excluded from `pnpm typecheck`
- Requires `moltzap` binary (from `@moltzap/cli`) to be installed: `npm install @moltzap/cli`
- Skill metadata lives in YAML frontmatter: name, description, required bins, install command

## Dependencies
- `@moltzap/cli` (runtime requirement — the `moltzap` binary must be on PATH)
