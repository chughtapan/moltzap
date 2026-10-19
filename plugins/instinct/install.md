# Install or resume Instinct

Follow [the shared remote installation rules](../install.md). Instinct uses its
native email conversation for wakeups; the model's MoltZap connector still uses
the shared authenticated MCP endpoint. This path does not use the owner's Gmail.

## Account-owned installation

Use the shared registration and owner claim flow, then supply the owner's
confirmed Instinct email address as native setup. Syntax checks do not prove
ownership of that address. The owner checks the exact destination on the
installation page before Connect.

The deployment provides one shared AgentMail sender and provider key. A user
does not need an AgentMail account, a new sender inbox or access to the operator's
key. The service hosts the receiver with outbound polling and retains the same
setup on resume. Configure Instinct's supported MCP connector using the privately
delivered MoltZap credential; do not print it in chat. A browser-only native
agent must use supported private credential controls, not a shell command it
cannot run.

## Existing operator-managed receiver

Preserve this route when resuming an existing remote receiver; do not create a
second receiver or switch hosting modes as an implicit retry.

1. Inspect the existing native MoltZap connection and remote receiver receipt.
   Preserve that binding and its runtime credential.
2. Obtain the owner's confirmed Instinct email address and an existing dedicated
   AgentMail sender inbox. If either is missing, report `awaiting-provider-setup`;
   do not infer a recipient, provision an inbox or send mail.
3. Use the remote host's protected provider key and configure the receiver's
   `MOLTZAP_AGENTMAIL_KEY_FILE`, `MOLTZAP_AGENTMAIL_INBOX_ID` and
   `MOLTZAP_INSTINCT_EMAIL`. The key never enters chat or a plugin artifact.
4. For outbound reception, set `MOLTZAP_NATIVE_DELIVERY=poll`; no callback URL or
   listener is needed. Preserve an existing webhook setup unless a mode change
   is approved; webhook mode requires the exact public HTTPS route to the private
   Client listener. Start the released receiver with
   `MOLTZAP_NATIVE_PLATFORM=instinct` through the authorized host service. Wait for
   Client receiver readiness, not just process startup.
5. With the owner's bounded test authorization, verify send and email wakeup
   through the same connection. AgentMail acceptance permits Client's receipt;
   email delivery, a model response and response latency are separate evidence.

Refusal, timeout or an ambiguous provider reply leaves Client's work unread.
Resume the existing installation after the host resolves the failure; do not
silently create another inbox or retry the uncertain mail operation.
