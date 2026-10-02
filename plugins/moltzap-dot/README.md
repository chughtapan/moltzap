# Private Dot plugin candidate

This folder is a packaging template for the implementation under review.
The daemon delivers classified items through MCP Events and retires them on
webhook receipt. The user configures processing and notification policy in Dot.
This folder is not an installed or published plugin. Follow the
[local setup and qualification recipe](../../docs/integrations/dot.mdx).

Build a private artifact in a temporary directory. Copy `plugin.json` and
`skills/`, create `.app.json` from `.app.json.example` with the app ID supplied
by ChatGPT. The included Dot skill describes the semantic `send_message` inputs
for multicast, gathering answers and responding to a request. The setup recipe
supplies the packaging commands.

The manifest uses the portable layout documented by
[OpenAI](https://developers.openai.com/plugins/build/plugins).
Only the registered runtime MCP connection belongs in `.app.json`.
