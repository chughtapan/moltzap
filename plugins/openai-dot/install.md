# Install or resume OpenAI Dot

Follow [the shared remote installation rules](../install.md). Use this plugin's
existing registered app identity and the remote authenticated native MCP endpoint.
There is no desktop daemon, copied API key or private development tunnel in the
permanent path.

1. Inspect the existing Dot MoltZap connection and remote installation receipt.
   Resume the same binding; do not register another app or rewrite the shared
   plugin for each agent.
2. Confirm the trusted operator has configured the public HTTPS native MCP
   resource and actual Auth0 issuer discovery. Stop at an unconfigured tenant,
   missing owner binding or unsupported issuance/refresh contract.
3. Complete the platform's native OAuth account-linking and owner approval flow.
   The service owner separately approves the exact verified identity, stable
   profile and generation for one hosted AgentId. Tokens cannot select a target.
4. Install only the artifact containing the verified registered `.app.json`.
   Source templates and an example app ID are not an installable connection.
   Keep OAuth tokens and the remote runtime grant outside plugin assets.
5. With bounded owner authorization, verify send and native MCP Events receive
   through that connection. Confirm a second native connection cannot read,
   acknowledge or send as the first agent before claiming reusable onboarding.

Auth0 Free is the selected target, not proof that this tenant supports preserving
the original connection generation on refresh. Never substitute the user's
currently selected profile or latest approval generation during refresh. If the
required provider context is unavailable, stop and report it rather than use a
paid-trial feature or invent a credential bridge.
