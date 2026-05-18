# Per-Adapter Spawn Details

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## 3.1 OpenClaw Adapter (`openclaw-adapter.ts`)

```mermaid
flowchart TD
    OCS["OpenClawAdapter.spawn(input)<br>openclaw-adapter.ts → OpenClawAdapter.spawn"]
    OC1["1. allocateFreePort()<br>NodeSocketServer.make({ host: &quot;127.0.0.1&quot;, port: 0 })<br>Reads ephemeral port; scope closed immediately<br>— port number recorded for openclaw.json config"]
    OC2["2. prepareOpenClawStateDir(deps, input)<br>makeTempDirectory({ prefix: &quot;openclaw-&lt;agentName&gt;-&quot; })<br>writeOpenClawConfig(stateDir, ...)<br>seedWorkspaceFiles(stateDir, input.workspaceFiles)<br>installChannelPlugin(stateDir, channelDistDir, repoRoot)"]
    OC3["3. buildOpenClawProcessPlan(openclawBin, port)<br>If openclawBin.endsWith(&quot;.mjs&quot;):<br>  command=&quot;node&quot; args=[openclawBin, &quot;gateway&quot;, &quot;run&quot;, ...]<br>Else:<br>  command=openclawBin args=[&quot;gateway&quot;, &quot;run&quot;, ...]"]
    OC4["4. spawnOpenClawProcess(command, args, cwd=stateDir)<br>env: OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH<br>Scope.make() → Command.start() → Scope.extend(scope)<br>exitFiber = proc.exitCode.forkIn(scope)<br>stdout + stderr fibers → logBuffer.value"]
    OC5["5. this.state = { process, stateDir, logBuffer,<br>   spawnInput, tornDown: false }"]
    OCR["Readiness — OpenClawAdapter.waitUntilReady<br>Race:<br>  server.awaitAgentReady(agentId, timeoutMs)<br>  processExitLoop({ pollExitCode: () =&gt; Fiber.poll(exitFiber),<br>                    stderr: () =&gt; logBuffer.value })<br>Readiness signal: server-side WS authentication event<br>Inbound marker: &quot;inbound from agent:&quot;"]

    OCS --> OC1 --> OC2 --> OC3 --> OC4 --> OC5 --> OCR
```

**Annotations:**
- `allocateFreePort` — `openclaw-adapter.ts → allocateFreePort`
- `prepareOpenClawStateDir` — `openclaw-adapter.ts → prepareOpenClawStateDir`
- `writeOpenClawConfig` — `openclaw-adapter.ts → writeOpenClawConfig`; writes `stateDir/openclaw.json` with model, workspace, moltzap channel account, gateway mode/auth
- `seedWorkspaceFiles` — `openclaw-adapter.ts → seedWorkspaceFiles`
- `installChannelPlugin` — `openclaw-adapter.ts → installChannelPlugin`; resolves `effect` dep via `resolveChannelDependency`; installs via `openclaw.plugin.json`
- `buildOpenClawProcessPlan` — `openclaw-adapter.ts → buildOpenClawProcessPlan`
- `spawnOpenClawProcess` — `openclaw-adapter.ts → spawnOpenClawProcess`
- `OpenClawAdapter.waitUntilReady` — `openclaw-adapter.ts → OpenClawAdapter.waitUntilReady`; inbound marker `openclaw-adapter.ts → inbound log marker`

## 3.2 Nanoclaw Adapter (`nanoclaw-adapter.ts` + `nanoclaw-process.ts`)

Nanoclaw is unique: it runs agent subprocesses **inside Docker containers**
via the OneCLI gateway. The adapter has a two-phase startup: first ensure the
runtime cache is installed, then launch.

```mermaid
flowchart TD
    NS["NanoclawAdapter.spawn(input)<br>nanoclaw-adapter.ts → NanoclawAdapter.spawn"]

    subgraph Phase1["Phase 1 — ensureNanoclawRuntimeInstalledEffect<br>nanoclaw-process.ts → ensureNanoclawRuntimeInstalledEffect"]
        P1C{"~/.cache/.../nanoclaw/&lt;sha12&gt;/.ready<br>exists?"}
        P1WARM["syncChannelFileIntoCache()<br>diff nanoclaw-channel moltzap.ts<br>diff client dist/channel-core.js<br>if either drifted: overwrite + npm run build"]
        P1COLD["preflightDocker()<br>execEffect(&quot;docker info&quot;, timeout=5000ms)"]
        P1DL["downloadTarball(NANOCLAW_URL, tmpDir)<br>curl -fsSL &lt;github tarball&gt;<br>NANOCLAW_SHA = qwibitai/nanoclaw@934f063..."]
        P1COPY["copyChannelFileIntoCache(tmpDir)<br>appendMoltzapBarrelImport(tmpDir)<br>copySharedSkillIntoCache(tmpDir)"]
        P1BUILD["buildNanoclawRuntimeCache(tmpDir)<br>npm install @moltzap/client@latest (120s)<br>npm install (300s)<br>npm run build (120s)<br>bash container/build.sh (300s)"]
        P1PROMOTE["promoteRuntimeCache(tmpDir → NANOCLAW_RUNTIME_CACHE)"]

        P1C -->|".ready exists (warm)"| P1WARM
        P1C -->|"cold install"| P1COLD --> P1DL --> P1COPY --> P1BUILD --> P1PROMOTE
    end

    subgraph Phase2["Phase 2 — startNanoclawRuntimeEffect<br>nanoclaw-process.ts → startNanoclawRuntimeEffect"]
        P2DIR["createNanoclawDataDir()<br>mktemp prefix=moltzap-nanoclaw-runtime-"]
        P2OC["ensureOnecliRunning()<br>probe http://127.0.0.1:10254 (timeout=2s)<br>if unreachable: docker compose -p onecli up -d --wait<br>probe up to 20×500ms"]
        P2WS["writeRuntimeWorkspaceFiles(workspaceFiles)<br>→ NANOCLAW_RUNTIME_CACHE/container/skills/&lt;path&gt;"]
        P2SP["startNanoclawProcess(opts, dataDir, capturedLogs)<br>command: &quot;node dist/index.js&quot;<br>cwd: NANOCLAW_RUNTIME_CACHE<br>env: MOLTZAP_API_KEY, MOLTZAP_SERVER_URL,<br>  MOLTZAP_EVAL_MODE=&quot;1&quot;, DATA_DIR,<br>  CONTAINER_RUNTIME=&quot;docker&quot;,<br>  ONECLI_URL=&quot;http://127.0.0.1:10254&quot;,<br>  LOG_LEVEL=&quot;info&quot;"]
        P2WAIT["waitForNanoclawConnection(exitFiber, capturedLogs)<br>Race (timeout=60s):<br>  waitForConnectedMarker: poll 200ms,<br>    scan capturedLogs for CONNECTED_MARKER<br>    /\\[info\\].*MoltZap connected|MoltZap connected/<br>  failIfProcessExitsBeforeConnect: Fiber.join(exitFiber)"]

        P2DIR --> P2OC --> P2WS --> P2SP --> P2WAIT
    end

    P2STATE["this.state = { handle, spawnInput, tornDown: false }"]
    NCR["Readiness — NanoclawAdapter.waitUntilReady<br>TWO gates:<br>1. Inner: waitForNanoclawConnection (stdout marker)<br>2. Outer: server.awaitAgentReady (server WS auth)<br><br>Outer race:<br>  server.awaitAgentReady(agentId, timeoutMs)<br>  processExitLoop({ pollExitCode: () =&gt; Fiber.poll(handle.exitFiber),<br>                    stderr: () =&gt; getNanoclawRuntimeLogs(handle) })<br>Inbound marker: &quot;New messages&quot;"]

    NS --> Phase1
    Phase1 --> Phase2
    Phase2 --> P2STATE --> NCR
```

**Annotations:**
- `ensureNanoclawRuntimeInstalledEffect` — `nanoclaw-process.ts → ensureNanoclawRuntimeInstalledEffect`
- `syncChannelFileIntoCache` — `nanoclaw-process.ts → syncChannelFileIntoCache`
- `preflightDocker` — `nanoclaw-process.ts → preflightDocker`
- `downloadTarball` — `nanoclaw-process.ts → downloadTarball`; `NANOCLAW_SHA` — `nanoclaw-process.ts → NANOCLAW_SHA`
- `copyChannelFileIntoCache`, `appendMoltzapBarrelImport`, `copySharedSkillIntoCache` — `nanoclaw-process.ts`
- `buildNanoclawRuntimeCache` — `nanoclaw-process.ts → buildNanoclawRuntimeCache`
- `startNanoclawRuntimeEffect` — `nanoclaw-process.ts → startNanoclawRuntimeEffect`
- `ensureOnecliRunning` — `nanoclaw-process.ts → ensureOnecliRunning`
- `startNanoclawProcess` — `nanoclaw-process.ts → startNanoclawProcess`
- `waitForNanoclawConnection` — `nanoclaw-process.ts → waitForNanoclawConnection`; `CONNECTED_MARKER` — `nanoclaw-process.ts → CONNECTED_MARKER`
- `NanoclawAdapter.waitUntilReady` — `nanoclaw-adapter.ts → NanoclawAdapter.waitUntilReady`; inbound marker — `nanoclaw-adapter.ts → inbound log marker`

## 3.3 ClaudeCode Adapter (`claude-code-adapter.ts`)

```mermaid
flowchart TD
    CCS["ClaudeCodeAdapter.spawn(input)<br>claude-code-adapter.ts → ClaudeCodeAdapter.spawn"]
    CC1["1. prepareClaudeCodeStateDir(deps, input)<br>makeTempDirectory({ prefix: &quot;claude-code-&lt;agentName&gt;-&quot; })<br>seedWorkspaceFiles(stateDir, input.workspaceFiles)<br>installClaudeCodeChannelPlugin(deps, stateDir)<br>  resolves @modelcontextprotocol/sdk + effect deps<br>  via resolveChannelDependency (parent node_modules walk)<br>  no openclaw.plugin.json — cc-channel has no OpenClaw manifest<br>  returns extDir (channel path inside stateDir)"]
    CC2["2. writeClaudeCodeMcpConfig(opts)<br>serverUrl: strip /ws, ws→http, wss→https<br>channelServerName = &quot;@moltzap/claude-code-channel/&lt;agentName&gt;&quot;<br>writes stateDir/mcp-config.json:<br>  { mcpServers: { moltzap: {<br>    command: &quot;node&quot;,<br>    args: [extDir/dist/cli.js],<br>    env: { MOLTZAP_API_KEY, MOLTZAP_SERVER_URL,<br>           MOLTZAP_SERVER_NAME: channelServerName }<br>  }}}"]
    CC3["3. spawnConfiguredClaude(deps, stateDir, mcpConfigPath, logBuffer)<br>buildClaudeArgs: --strict-mcp-config<br>  --mcp-config &lt;mcpConfigPath&gt;<br>  --print --input-format stream-json<br>  --output-format stream-json --verbose<br>  --dangerously-skip-permissions<br>  --add-dir &lt;stateDir/workspace&gt;<br>spawnClaudeProcess(claudeBin, args,<br>  cwd=stateDir, env={ CLAUDE_CODE_HOME: stateDir },<br>  stdin=&quot;inherit&quot;)<br>Scope.make() → Command.start() → Scope.extend(scope)<br>exitFiber = proc.exitCode.forkIn(scope)<br>stdout + stderr fibers → logBuffer.value"]
    CC4["4. this.state = { process, stateDir, spawnInput,<br>   logBuffer, tornDown: false }"]
    CCR["Readiness — ClaudeCodeAdapter.waitUntilReady<br>Race:<br>  server.awaitAgentReady(agentId, timeoutMs)<br>    (cc-channel's MCP stdio server authenticates on start)<br>  processExitLoop({ pollExitCode: () =&gt; pollClaudeExitCode(proc),<br>                    stderr: () =&gt; logBuffer.value })<br>Binary: claudeBin (&quot;claude&quot; CLI, @anthropic-ai/claude-code)<br>Claude spawns cc-channel as MCP stdio child automatically<br>  (SIGTERM on claude propagates to cc-channel naturally —<br>   no process-group kill needed, unlike openclaw)<br>Readiness signal: server-side WS authentication event<br>Inbound marker: &quot;notifications/claude/channel&quot;<br>  (cc-channel sends MCP notifications/claude/channel<br>   per inbound message; visible in --verbose output)"]

    CCS --> CC1 --> CC2 --> CC3 --> CC4 --> CCR
```

**Annotations:**
- `prepareClaudeCodeStateDir` — `claude-code-adapter.ts → prepareClaudeCodeStateDir`
- `installClaudeCodeChannelPlugin` — `claude-code-adapter.ts → installClaudeCodeChannelPlugin`
- `writeClaudeCodeMcpConfig` — `claude-code-process.ts → writeClaudeCodeMcpConfig`
- `buildClaudeArgs` — `claude-code-adapter.ts → buildClaudeArgs`
- `spawnClaudeProcess` — `claude-code-adapter.ts → spawnClaudeProcess`
- `ClaudeCodeAdapter.waitUntilReady` — `claude-code-adapter.ts → ClaudeCodeAdapter.waitUntilReady`; inbound marker — `claude-code-adapter.ts → inbound log marker`

## See Also

- [Single-Runtime Startup](./01-single-runtime-startup.md)
- [Workspace Path Resolution](./04-workspace-path-resolution.md)
- [Shutdown Propagation](./05-shutdown-propagation.md)
- [Process State Machine](./07-process-state-machine.md)
