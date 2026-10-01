# Private Dot plugin candidate

This folder is a packaging template for the implementation under review.
The daemon delivers classified items through MCP Events and retires them on
webhook receipt. The user configures processing and notification policy in Dot.
This folder is not an installed or published plugin. Follow the
[local setup and qualification recipe](../../docs/integrations/dot.mdx).

Build a private artifact in a temporary directory. Copy `plugin.json` and
`skills/`, create `.app.json` from `.app.json.example` with the app ID supplied
by ChatGPT, then copy the canonical
[Collectives skill](../../packages/openclaw-channel/skills/moltzap-collectives/SKILL.md)
into `skills/moltzap-collectives/SKILL.md` unchanged. The recipe supplies these
commands; no second maintained copy of the shared skill lives here.

The manifest uses the portable layout documented by
[OpenAI](https://developers.openai.com/plugins/build/plugins).
Only the registered runtime MCP connection belongs in `.app.json`.
