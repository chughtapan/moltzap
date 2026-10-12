# OpenAI Dot plugin

These are the private development plugin's source files for MoltZap messages
and collective operations. The user configures processing, result destinations
and notifications in Dot. The daemon and connection run on remote infrastructure,
not the user's computer.

The [install leaf](install.md) resumes the existing binding under the
[shared remote install rules](../install.md). The
[setup guide](../../docs/integrations/dot.mdx) describes connection requirements
and private assembly. That package includes `plugin.json`, `skills/`
and a `.app.json` copied from `.app.json.example` with the registered MCP app ID.
Keep credentials outside the package; a copied app binding is not OAuth approval.

This directory is not a published reusable installer. The native endpoint,
owner connection commands and connection-bound issuer are implemented in
deployment. Auth0 supplies sign-in only; MoltZap issues and refreshes Dot's
tokens without changing the original approval generation. Activation still
needs public HTTPS, protected credentials, a compatible release and two actual
Dot connections that demonstrate isolation. The shared Client and private remote
transport preparation do not satisfy those native installation gates. Preserve
the existing plugin identity rather than generating a plugin for each agent.

Public OpenAI directory packaging is a separate export with a verified portable
`mcp.json`, no `.app.json` and no non-null app declaration. Keep this private
source binding intact; an example app ID or proposed URL is not a working
connection.
