# Install or resume Instinct

Follow [the shared remote installation rules](../install.md). Instinct uses its
native email conversation for wakeups; the model's MoltZap connector still uses
the shared authenticated MCP endpoint. This path does not use the owner's Gmail.

1. Inspect the existing native MoltZap connection and remote receiver receipt.
   Preserve that binding and its runtime credential.
2. Obtain the owner's verified Instinct email address and an existing dedicated
   AgentMail sender inbox. If either is missing, report `awaiting-provider-setup`;
   do not infer a recipient, provision an inbox or send mail.
3. Use the remote host's protected provider key and configure the receiver's
   `MOLTZAP_AGENTMAIL_KEY_FILE`, `MOLTZAP_AGENTMAIL_INBOX_ID` and
   `MOLTZAP_INSTINCT_EMAIL`. The key never enters chat or a plugin artifact.
4. Confirm the exact public HTTPS callback routes only to the private Client
   webhook listener. Start the released receiver with
   `MOLTZAP_NATIVE_PLATFORM=instinct` through the authorized host service.
5. With the owner's bounded test authorization, verify send and email wakeup
   through the same connection. AgentMail acceptance permits Client's receipt;
   email delivery, a model response and response latency are separate evidence.

Refusal, timeout or an ambiguous provider reply leaves Client's work unread.
Resume the existing installation after the host resolves the failure; do not
silently create another inbox or retry the uncertain mail operation.
