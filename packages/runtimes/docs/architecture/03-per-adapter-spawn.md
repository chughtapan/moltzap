# Per-Adapter Spawn Details

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## 3.1 OpenClaw Adapter (`openclaw-adapter.ts`)

```mermaid
flowchart TD
    OCS["OpenClawAdapter.spawn(input)\nopenclaw-adapter.ts → OpenClawAdapter.spawn"]
    OC1["1. allocateFreePort()\nNodeSocketServer.make({ host: &quot;127.0.0.1&quot;, port: 0 })\nReads ephemeral port; scope closed immediately\n— port number recorded for openclaw.json config"]
    OC2["2. prepareOpenClawStateDir(deps, input)\nmakeTempDirectory({ prefix: &quot;openclaw-&lt;agentName&gt;-&quot; })\nwriteOpenClawConfig(stateDir, ...)\nseedWorkspaceFiles(stateDir, input.workspaceFiles)\ninstallChannelPlugin(stateDir, channelDistDir, repoRoot)"]
    OC3["3. buildOpenClawProcessPlan(openclawBin, port)\nIf openclawBin.endsWith(&quot;.mjs&quot;):\n  command=&quot;node&quot; args=[openclawBin, &quot;gateway&quot;, &quot;run&quot;, ...]\nElse:\n  command=openclawBin args=[&quot;gateway&quot;, &quot;run&quot;, ...]"]
    OC4["4. spawnOpenClawProcess(command, args, cwd=stateDir)\nenv: OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH\nScope.make() → Command.start() → Scope.extend(scope)\nexitFiber = proc.exitCode.forkIn(scope)\nstdout + stderr fibers → logBuffer.value"]
    OC5["5. this.state = { process, stateDir, logBuffer,\n   spawnInput, tornDown: false }"]
    OCR["Readiness — OpenClawAdapter.waitUntilReady\nRace:\n  server.awaitAgentReady(agentId, timeoutMs)\n  processExitLoop({ pollExitCode: () =&gt; Fiber.poll(exitFiber),\n                    stderr: () =&gt; logBuffer.value })\nReadiness signal: server-side WS authentication event\nInbound marker: &quot;inbound from agent:&quot;"]

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
    NS["NanoclawAdapter.spawn(input)\nnanoclaw-adapter.ts → NanoclawAdapter.spawn"]

    subgraph Phase1["Phase 1 — ensureNanoclawRuntimeInstalledEffect\nnanoclaw-process.ts → ensureNanoclawRuntimeInstalledEffect"]
        P1C{"~/.cache/.../nanoclaw/&lt;sha12&gt;/.ready\nexists?"}
        P1WARM["syncChannelFileIntoCache()\ndiff nanoclaw-channel moltzap.ts\ndiff client dist/channel-core.js\nif either drifted: overwrite + npm run build"]
        P1COLD["preflightDocker()\nexecEffect(&quot;docker info&quot;, timeout=5000ms)"]
        P1DL["downloadTarball(NANOCLAW_URL, tmpDir)\ncurl -fsSL &lt;github tarball&gt;\nNANOCLAW_SHA = qwibitai/nanoclaw@934f063..."]
        P1COPY["copyChannelFileIntoCache(tmpDir)\nappendMoltzapBarrelImport(tmpDir)\ncopySharedSkillIntoCache(tmpDir)"]
        P1BUILD["buildNanoclawRuntimeCache(tmpDir)\nnpm install @moltzap/client@latest (120s)\nnpm install (300s)\nnpm run build (120s)\nbash container/build.sh (300s)"]
        P1PROMOTE["promoteRuntimeCache(tmpDir → NANOCLAW_RUNTIME_CACHE)"]

        P1C -->|".ready exists (warm)"| P1WARM
        P1C -->|"cold install"| P1COLD --> P1DL --> P1COPY --> P1BUILD --> P1PROMOTE
    end

    subgraph Phase2["Phase 2 — startNanoclawRuntimeEffect\nnanoclaw-process.ts → startNanoclawRuntimeEffect"]
        P2DIR["createNanoclawDataDir()\nmktemp prefix=moltzap-nanoclaw-runtime-"]
        P2OC["ensureOnecliRunning()\nprobe http://127.0.0.1:10254 (timeout=2s)\nif unreachable: docker compose -p onecli up -d --wait\nprobe up to 20×500ms"]
        P2WS["writeRuntimeWorkspaceFiles(workspaceFiles)\n→ NANOCLAW_RUNTIME_CACHE/container/skills/&lt;path&gt;"]
        P2SP["startNanoclawProcess(opts, dataDir, capturedLogs)\ncommand: &quot;node dist/index.js&quot;\ncwd: NANOCLAW_RUNTIME_CACHE\nenv: MOLTZAP_API_KEY, MOLTZAP_SERVER_URL,\n  MOLTZAP_EVAL_MODE=&quot;1&quot;, DATA_DIR,\n  CONTAINER_RUNTIME=&quot;docker&quot;,\n  ONECLI_URL=&quot;http://127.0.0.1:10254&quot;,\n  LOG_LEVEL=&quot;info&quot;"]
        P2WAIT["waitForNanoclawConnection(exitFiber, capturedLogs)\nRace (timeout=60s):\n  waitForConnectedMarker: poll 200ms,\n    scan capturedLogs for CONNECTED_MARKER\n    /\\[info\\].*MoltZap connected|MoltZap connected/\n  failIfProcessExitsBeforeConnect: Fiber.join(exitFiber)"]

        P2DIR --> P2OC --> P2WS --> P2SP --> P2WAIT
    end

    P2STATE["this.state = { handle, spawnInput, tornDown: false }"]
    NCR["Readiness — NanoclawAdapter.waitUntilReady\nTWO gates:\n1. Inner: waitForNanoclawConnection (stdout marker)\n2. Outer: server.awaitAgentReady (server WS auth)\n\nOuter race:\n  server.awaitAgentReady(agentId, timeoutMs)\n  processExitLoop({ pollExitCode: () =&gt; Fiber.poll(handle.exitFiber),\n                    stderr: () =&gt; getNanoclawRuntimeLogs(handle) })\nInbound marker: &quot;New messages&quot;"]

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
    CCS["ClaudeCodeAdapter.spawn(input)\nclaude-code-adapter.ts → ClaudeCodeAdapter.spawn"]
    CC1["1. prepareClaudeCodeStateDir(deps, input)\nmakeTempDirectory({ prefix: &quot;claude-code-&lt;agentName&gt;-&quot; })\nseedWorkspaceFiles(stateDir, input.workspaceFiles)\ninstallClaudeCodeChannelPlugin(deps, stateDir)\n  resolves @modelcontextprotocol/sdk + effect deps\n  via resolveChannelDependency (parent node_modules walk)\n  no openclaw.plugin.json — cc-channel has no OpenClaw manifest\n  returns extDir (channel path inside stateDir)"]
    CC2["2. writeClaudeCodeMcpConfig(opts)\nserverUrl: strip /ws, ws→http, wss→https\nchannelServerName = &quot;@moltzap/claude-code-channel/&lt;agentName&gt;&quot;\nwrites stateDir/mcp-config.json:\n  { mcpServers: { moltzap: {\n    command: &quot;node&quot;,\n    args: [extDir/dist/cli.js],\n    env: { MOLTZAP_API_KEY, MOLTZAP_SERVER_URL,\n           MOLTZAP_SERVER_NAME: channelServerName }\n  }}}"]
    CC3["3. spawnConfiguredClaude(deps, stateDir, mcpConfigPath, logBuffer)\nbuildClaudeArgs: --strict-mcp-config\n  --mcp-config &lt;mcpConfigPath&gt;\n  --print --input-format stream-json\n  --output-format stream-json --verbose\n  --dangerously-skip-permissions\n  --add-dir &lt;stateDir/workspace&gt;\nspawnClaudeProcess(claudeBin, args,\n  cwd=stateDir, env={ CLAUDE_CODE_HOME: stateDir },\n  stdin=&quot;inherit&quot;)\nScope.make() → Command.start() → Scope.extend(scope)\nexitFiber = proc.exitCode.forkIn(scope)\nstdout + stderr fibers → logBuffer.value"]
    CC4["4. this.state = { process, stateDir, spawnInput,\n   logBuffer, tornDown: false }"]
    CCR["Readiness — ClaudeCodeAdapter.waitUntilReady\nRace:\n  server.awaitAgentReady(agentId, timeoutMs)\n    (cc-channel's MCP stdio server authenticates on start)\n  processExitLoop({ pollExitCode: () =&gt; pollClaudeExitCode(proc),\n                    stderr: () =&gt; logBuffer.value })\nBinary: claudeBin (&quot;claude&quot; CLI, @anthropic-ai/claude-code)\nClaude spawns cc-channel as MCP stdio child automatically\n  (SIGTERM on claude propagates to cc-channel naturally —\n   no process-group kill needed, unlike openclaw)\nReadiness signal: server-side WS authentication event\nInbound marker: &quot;notifications/claude/channel&quot;\n  (cc-channel sends MCP notifications/claude/channel\n   per inbound message; visible in --verbose output)"]

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
