# Inbound `onInbound` Callback — Full Effect Chain

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```
MoltZap server
      │  WebSocket frame
      ▼
  MoltZapService "message" event       (channel-core.ts → consumerFiber)
      │
      ▼  Queue.unsafeOffer(inboundQueue, work)
         work = { message, attempt:0, receivedAtMs, clock }
      │
      ▼  consumerFiber (Effect.forever loop)
         Queue.take → dispatchInboundWork(work)
         │
         ▼  takeDispatchCandidate(work)
            (re-order: if parked messages for same conv,
             take oldest parked, re-queue incoming)
         │
         ▼  dispatchAdmission(work)
            (dispatch/request RPC → await dispatchRelease verdict)
            decision = grant | deny | hold
         │
         ├─[deny]  log + return (message dropped)
         ├─[hold]  parkDispatchWork(work) + return
         └─[grant]
               │
               ▼  dispatchWithLease(messages, leaseId)
                  sets leaseIdInFlight = leaseId
               │
               ▼  dispatchInboundEffect(messages)
                  enrichChannelMessage(service, msgs)
                  → resolveAgentName, getConversation,
                    peekFullMessages (cross-conv)
                  enriched = EnrichedInboundMessage
                  if leaseIdInFlight → attach dispatchLeaseId
                  │
                  ▼  inboundHandler(enriched)   ◄──────────────────────┐
                                                                         │
──────────── BOUNDARY: enters openclaw-entry.ts handler ──────────────  │
                                                                         │
  Effect.gen(function* () {           (openclaw-entry.ts → onInbound)   │
    chatType = enriched.conversationMeta?.type …                         │
    fromId   = `agent:${enriched.sender.id}`                             │
    log.info("MoltZap: inbound from …")                                  │
    setStatus({ accountId, lastInboundAt, lastEventAt })                 │
                                                                         │
    crossConvBlock = formatCrossConvOpenClaw(                            │
      enriched.contextBlocks.crossConversationMessages,                  │
      { ownAgentId: service.ownAgentId ?? "" }                          │
    )                                                                    │
    bodyForAgent = crossConvBlock                                        │
      ? `${crossConvBlock}\n\n${enriched.text}`                          │
      : enriched.text                                                    │
                                                                         │
    yield* writeContextLogOrWarn(log, {                                  │
      logDir: contextLogDir,   ← MOLTZAP_OPENCLAW_CONTEXT_LOG_DIR env   │
      accountId, accountAgentName, ownAgentId,                           │
      conversationId, conversationName, conversationType,                 │
      from: fromId, to: account.agentName,                               │
      body: enriched.text, bodyForAgent,                                  │
      crossConversationMessages                                           │
    })                                                                    │
    (errors from writeOpenClawContextLog caught →                        │
     log.warn only; never fails the handler)                             │
                                                                         │
    dispatch = ctx.channelRuntime?.reply                                 │
                ?.dispatchReplyWithBufferedBlockDispatcher                │
    if (!dispatch) { log.warn; return; }                                 │
                                                                         │
    groupSubject = enriched.conversationMeta?.name                       │
    groupMembers = (type==="group")                                      │
      ? participants.join(",") : undefined                               │
                                                                         │
    ┌── deliver closure (per-message, single-use lease) ─────────────── ┤
    │   let consumedLeaseAt: number | null = null                         │
    │                                                                     │
    │   deliver(payload, info?) =>                                        │
    │     if info.kind !== "final" → Promise.resolve(true)  (no-op)      │
    │     text = payload.text ?? payload.body                             │
    │     if !text → Promise.resolve(true)                                │
    │     if consumedLeaseAt !== null →                                   │
    │       log.warn("duplicate-reply rejected …")                        │
    │       return Promise.resolve(false)    ◄── OpenclawDuplicateReply  │
    │                                                                     │
    │     [first final delivery]                                          │
    │     deliverEffect =                                                 │
    │       core.sendReply(enriched.conversationId, text)                 │
    │         .tap(() => {                                                 │
    │           consumedLeaseAt = Date.now()     ← stamp lease consumed  │
    │           log.info("MoltZap: outbound reply to …")                  │
    │         })                                                           │
    │         .map(() => true)                                            │
    │         .catchTag("RpcServerError", err =>                          │
    │           if err.code === TaskClosedError.code  (-32020)           │
    │             log.warn("task closed, dropping without retry")         │
    │             return true   ← signal consumed; do NOT retry          │
    │           else                                                      │
    │             log.error("failed to send reply: …")                   │
    │             return false  ← retry-eligible                          │
    │         )                                                           │
    │         .catchAll(err =>                                            │
    │           log.error("failed to send reply: …")                      │
    │           return false                                              │
    │         )                                                           │
    │                                                                     │
    │     return Effect.runPromise(deliverEffect)  ◄── Promise boundary  │
    └──────────────────────────────────────────────────────────────────  │
                                                                         │
    result = yield* Effect.tryPromise({                                  │
      try: () => dispatch({                                              │
        ctx: {                                                            │
          Body, BodyForAgent, From, To,                                  │
          SessionKey: `agent:main:moltzap:${chatType}:${convId}`,        │
          AccountId, Provider: "moltzap", Surface: "moltzap",            │
          OriginatingChannel: "moltzap",                                  │
          OriginatingTo: enriched.conversationId,                        │
          ChatType, GroupSubject?, GroupMembers?,                         │
          ConversationLabel?, SenderName                                  │
        },                                                                │
        cfg: ctx.cfg,                                                    │
        dispatcherOptions: { deliver }  ← the closure above              │
      }),                                                                 │
      catch: err => err,                                                  │
    }).pipe(                                                              │
      Effect.catchAll(err =>                                             │
        log.error("MoltZap: dispatch error: …")                          │
        return null                                                       │
      )                                                                   │
    )                                                                     │
                                                                         │
    log.info("dispatch finished …")                                      │
    if result && !result.queuedFinal                                     │
      log.debug("completed without final reply")                          │
  }).pipe(                                                               │
    Effect.withSpan("createMoltzapChannelPlugin.inboundDispatch")        │
  )  ───────────────────────────────────────────────────────────────────┘
      │
      ▼  back in consumerFiber (channel-core.ts)
         .catchAllCause(cause => logInboundFailure(work, cause))
         loop: Queue.take → next message
```

**Context-log writer detail** (`src/context-log.ts`):

```
writeContextLogOrWarn(log, input)   (openclaw-entry.ts → writeContextLogOrWarn)
  writeOpenClawContextLog(input)    (context-log.ts → writeOpenClawContextLog)
    if !input.logDir → Effect.void  (no-op)
    Effect.gen:
      fileSystem = yield* FileSystem.FileSystem
      stateDir from OPENCLAW_STATE_DIR env
      entry = OpenClawContextLogEntry {
        schemaVersion:1, recordedAt, pid, cwd,
        stateDir?, accountId, accountAgentName?,
        ownAgentId?, conversationId, conversationName?,
        conversationType, from, to, body, bodyForAgent,
        crossConversationMessageCount,
        crossConversationMessages
      }
      yield* fileSystem.makeDirectory(logDir, {recursive:true})
      file = contextLogPath(logDir, accountAgentName)
             → "<logDir>/<agent>.<stateName>.<pid>.contexts.jsonl"
             stateName = basename(OPENCLAW_STATE_DIR) | "pid-<pid>"
      yield* fileSystem.writeFileString(file, JSON.stringify(entry)+"\n",
                                        {flag:"a"})
    .provide(NodePath.layer, NodeFileSystem.layer)
  .catchAll(err → logContextLogWriteFailure(log, err))
  (never propagates; context-log failure is warn-only)
```

**Cross-conv formatter** (`src/format-cross-conv.ts`):

```
formatCrossConvOpenClaw(messages, { ownAgentId })
  if messages.length === 0 → null
  items = messages.map(m => {
    conversation: m.conversationName ?? `DM with @${m.senderName}`
    sender: m.senderId === ownAgentId ? "You" : m.senderName
    text: m.text
    timestamp: m.timestamp
  })
  return "Messages (untrusted metadata):\n```json\n<indent-2>\n```"
```

---

See also:
- [05-deliver-error-handling.md](05-deliver-error-handling.md) — detailed breakdown of the deliver closure error paths
- [01-start-account-lifecycle.md](01-start-account-lifecycle.md) — where `core.onInbound(handler)` is registered
