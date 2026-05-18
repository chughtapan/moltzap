# Inbound `onInbound` Callback — Full Effect Chain

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## Part 1 — Consumer Fiber Path (channel-core.ts)

```mermaid
sequenceDiagram
    participant WS as MoltZap server (WebSocket)
    participant Svc as MoltZapService
    participant Q as inboundQueue
    participant CF as consumerFiber (Effect.forever)
    participant DA as dispatchAdmission

    WS->>Svc: WebSocket frame ("message" event)
    Svc->>Q: Queue.unsafeOffer(inboundQueue, work)<br>work = { message, attempt:0, receivedAtMs, clock }

    loop Effect.forever
        CF->>Q: Queue.take
        CF->>CF: takeDispatchCandidate(work)<br>(re-order: if parked messages for same conv,<br> take oldest parked, re-queue incoming)
        CF->>DA: dispatchAdmission(work)<br>(dispatch/request RPC → await dispatchRelease verdict)

        alt deny
            DA-->>CF: log + return (message dropped)
        else hold
            DA-->>CF: parkDispatchWork(work) + return
        else grant
            CF->>CF: dispatchWithLease(messages, leaseId)<br>sets leaseIdInFlight = leaseId
            CF->>CF: dispatchInboundEffect(messages)<br>enrichChannelMessage(service, msgs)<br>→ resolveAgentName, getConversation,<br>  peekFullMessages (cross-conv)<br>enriched = EnrichedInboundMessage<br>if leaseIdInFlight → attach dispatchLeaseId
            CF->>CF: inboundHandler(enriched)
            Note over CF: → see Part 2 (openclaw-entry.ts handler)
            CF->>CF: .catchAllCause(cause => logInboundFailure(work, cause))
        end
    end
```

## Part 2 — Inbound Handler (openclaw-entry.ts)

```mermaid
sequenceDiagram
    participant CF as consumerFiber
    participant H as onInbound handler (Effect.gen)
    participant CL as writeContextLogOrWarn
    participant D as deliver closure

    CF->>H: inboundHandler(enriched)

    Note over H: Effect.gen — inside Effect world

    H->>H: chatType = enriched.conversationMeta?.type<br>fromId = "agent:${enriched.sender.id}"<br>log.info("MoltZap: inbound from …")<br>setStatus({ accountId, lastInboundAt, lastEventAt })

    H->>H: crossConvBlock = formatCrossConvOpenClaw(<br>  enriched.contextBlocks.crossConversationMessages,<br>  { ownAgentId: service.ownAgentId ?? "" }<br>)<br>bodyForAgent = crossConvBlock<br>  ? crossConvBlock + "\n\n" + enriched.text<br>  : enriched.text

    H->>CL: yield* writeContextLogOrWarn(log, {<br>  logDir: contextLogDir (MOLTZAP_OPENCLAW_CONTEXT_LOG_DIR),<br>  accountId, accountAgentName, ownAgentId,<br>  conversationId, conversationName, conversationType,<br>  from, to, body, bodyForAgent, crossConversationMessages<br>})
    Note over CL: errors caught → log.warn only— never fails the handler

    H->>H: dispatch = ctx.channelRuntime?.reply<br>          ?.dispatchReplyWithBufferedBlockDispatcher
    alt dispatch not available
        H->>H: log.warn + return
    else dispatch available
        H->>H: groupSubject = enriched.conversationMeta?.name<br>groupMembers = (type==="group") ? participants.join(",") : undefined
        H->>H: build deliver closure (see Part 3)
        H->>H: yield* Effect.tryPromise({ try: () => dispatch({<br>  ctx: { Body, BodyForAgent, From, To,<br>    SessionKey, AccountId, Provider, Surface,<br>    OriginatingChannel, OriginatingTo,<br>    ChatType, GroupSubject?, GroupMembers?,<br>    ConversationLabel?, SenderName },<br>  cfg: ctx.cfg,<br>  dispatcherOptions: { deliver }<br>}), catch: err => err }).pipe(<br>  Effect.catchAll(err => log.error + null)<br>)
        H->>H: log.info("dispatch finished …")<br>if result &amp—&amp— !result.queuedFinal → log.debug
    end

    Note over H,CF: Effect.withSpan("createMoltzapChannelPlugin.inboundDispatch")
    H-->>CF: Effect completes → consumerFiber loops
```

## Part 3 — Deliver Closure (per-message, single-use lease)

```mermaid
flowchart TD
    A["deliver(payload, info?)"] --> B{"info.kind !== 'final'?"}
    B -->|yes| C["Promise.resolve(true) — no-op"]
    B -->|no| D{"text = payload.text ?? payload.body<br>text empty?"}
    D -->|yes| E["Promise.resolve(true)"]
    D -->|no| F{"consumedLeaseAt !== null?"}
    F -->|yes| G["log.warn('duplicate-reply rejected …')<br>Promise.resolve(false) — OpenclawDuplicateReply"]
    F -->|no — first final delivery| H["build deliverEffect:<br>core.sendReply(enriched.conversationId, text)"]

    H --> I["tap: consumedLeaseAt = Date.now()<br>log.info('MoltZap: outbound reply to …')"]
    I --> J[".map(() => true)"]
    J --> K{".catchTag('RpcServerError')"}
    K -->|"err.code === TaskClosedError.code (-32020)"| L["log.warn('task closed, dropping without retry')<br>return true — signal consumed; do NOT retry"]
    K -->|other RpcServerError| M["log.error('failed to send reply: …')<br>return false — retry-eligible"]
    J --> N{".catchAll(err)"}
    N --> O["log.error('failed to send reply: …')<br>return false"]

    L --> P["Effect.runPromise(deliverEffect)"]
    M --> P
    O --> P
    J --> P

    P --> Q["Promise&lt;boolean&gt; → OpenClaw runtime<br>true = delivered / terminal-consumed<br>false = retry eligible"]

    style P fill:#f0f0f0,stroke:#999
    style Q fill:#e8f4e8,stroke:#4a8
```

**Context-log writer detail** (`src/context-log.ts`):

```mermaid
flowchart LR
    A["writeContextLogOrWarn(log, input)<br>openclaw-entry.ts"] --> B["writeOpenClawContextLog(input)<br>context-log.ts"]
    B --> C{"input.logDir set?"}
    C -->|no| D["Effect.void — no-op"]
    C -->|yes| E["Effect.gen:<br>yield* FileSystem.FileSystem<br>stateDir from OPENCLAW_STATE_DIR"]
    E --> F["build OpenClawContextLogEntry {<br>  schemaVersion:1, recordedAt, pid, cwd,<br>  stateDir?, accountId, accountAgentName?,<br>  ownAgentId?, conversationId, conversationName?,<br>  conversationType, from, to, body, bodyForAgent,<br>  crossConversationMessageCount,<br>  crossConversationMessages<br>}"]
    F --> G["yield* fileSystem.makeDirectory(logDir, {recursive:true})"]
    G --> H["file = contextLogPath(logDir, accountAgentName)<br>→ logDir/agent.stateName.pid.contexts.jsonl<br>stateName = basename(OPENCLAW_STATE_DIR) | 'pid-&lt;pid&gt;'"]
    H --> I["yield* fileSystem.writeFileString(file,<br>  JSON.stringify(entry)+newline, {flag:'a'})"]
    I --> J[".provide(NodePath.layer, NodeFileSystem.layer)"]
    B --> K[".catchAll(err → logContextLogWriteFailure(log, err))<br>never propagates; context-log failure is warn-only"]
```

**Cross-conv formatter** (`src/format-cross-conv.ts`):

```mermaid
flowchart LR
    A["formatCrossConvOpenClaw(messages, { ownAgentId })"] --> B{"messages.length === 0?"}
    B -->|yes| C["return null"]
    B -->|no| D["items = messages.map(m => {<br>  conversation: m.conversationName ?? 'DM with @' + m.senderName<br>  sender: m.senderId === ownAgentId ? 'You' : m.senderName<br>  text: m.text<br>  timestamp: m.timestamp<br>})"]
    D --> E["return formatted string:<br>'Messages (untrusted metadata):\<br>json block with 2-space indent'"]
```

---

See also:
- [05-deliver-error-handling.md](05-deliver-error-handling.md) — detailed breakdown of the deliver closure error paths
- [01-start-account-lifecycle.md](01-start-account-lifecycle.md) — where `core.onInbound(handler)` is registered
