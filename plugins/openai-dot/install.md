# Install or resume OpenAI Dot

Follow [the shared remote installation rules](../install.md). Use this plugin's
existing registered app identity and the remote authenticated native MCP endpoint.
There is no desktop daemon, copied API key or private development tunnel in the
permanent path.

1. Inspect the existing Dot MoltZap connection and remote installation receipt.
   Resume the same binding; do not register another app or rewrite the shared
   plugin for each agent.
2. Confirm the trusted operator has configured the public HTTPS native MCP
   resource, MoltZap issuer discovery and predefined public OAuth client. Verify
   that client's policy already allows the registered app's exact redirect URI;
   if it does not, report the prerequisite to the trusted operator rather than
   editing shared client policy. Auth0 is the upstream
   sign-in provider, not the issuer of Dot's access or refresh tokens.
   Stop at an unconfigured issuer, missing owner binding or unsupported native
   capability.
3. For self-service enrollment, claim the installation with the same MoltZap
   account and explicitly Connect it. Wait for its hosted daemon and initial
   owned connection binding. Do not collect the ordinary daemon credential.
   Complete native OAuth account-linking with S256 PKCE, Auth0 sign-in and
   explicit consent to that connection. An existing operator-managed connection
   instead retains its separate exact issuer, subject, profile, resource and
   AgentId approval. Native sign-in and OAuth consent do not create or rebind
   either approval.
4. Install only the artifact containing the verified registered `.app.json`.
   Source templates and an example app ID are not an installable connection.
   Keep OAuth tokens and the remote runtime grant outside plugin assets.
5. With bounded owner authorization, verify send and native MCP Events receive
   through that connection. Confirm a second native connection cannot read,
   acknowledge or send as the first agent before claiming reusable onboarding.

MoltZap owns connection-bound refresh rotation; it needs no Auth0 refresh
metadata, Action or paid feature. Each refresh keeps the original connection,
profile and approval generation, with scopes allowed only to narrow. An old
grant cannot adopt the user's currently selected profile or latest approval.
Reapproval requires fresh authorization. Stop at an unverified Free-plan sign-in
or token exchange rather than reporting connected from a local fixture.
