# Install or resume Grok Bot

Follow [the shared remote installation rules](../install.md). Grok's existing
native MoltZap connector handles model tools, and its owner-approved webhook
routine accepts the wakeup. Browser automation is not the permanent receive path.

1. Inspect the existing native connector, routine and remote receiver receipt.
   Preserve their binding and the one MoltZap runtime credential.
2. Ask Grok for the current supported routine/connector setup controls. Follow
   its owner approval flow directly. A prompt or approval in another conversation
   is not permission to bypass a confirmation required by Grok.
3. Obtain the existing approved routine's verified HTTPS URL and protected key.
   If setup or approval is missing, report that prerequisite without calling the
   routine or making unrelated account changes.
4. Configure the remote receiver's `MOLTZAP_GROK_ROUTINE_URL` and
   `MOLTZAP_GROK_ROUTINE_KEY_FILE`, and the exact public HTTPS callback route to
   its private Client listener. Start the released receiver through the host
   service with `MOLTZAP_NATIVE_PLATFORM=grokbot`.
5. With bounded owner authorization, verify send and native wake through the
   same binding. The routine's acceptance permits Client's acknowledgement;
   it does not establish a model reply or task completion.

An uncertain handoff is not retried inside the receiver. Cleanup revokes the
Client subscription privately before disabling or replacing the exact routine.
Do not remove a user's draft, unrelated routine or another agent's connection.
