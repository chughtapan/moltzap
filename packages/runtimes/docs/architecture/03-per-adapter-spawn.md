# Per-Adapter Spawn Details

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

## 3.1 OpenClaw Adapter (`openclaw-adapter.ts`)

```text
OpenClawAdapter.spawn(input)                               openclaw-adapter.ts → OpenClawAdapter.spawn

  1. allocateFreePort()                                    openclaw-adapter.ts → allocateFreePort
       NodeSocketServer.make({ host: "127.0.0.1", port: 0 })
       Reads ephemeral port from server.address.port
       Scope is immediately closed — port is released, but its
       number is recorded for use in the openclaw.json config.

  2. prepareOpenClawStateDir(deps, input)                  openclaw-adapter.ts → prepareOpenClawStateDir
       makeTempDirectory({ prefix: "openclaw-<agentName>-" })
       writeOpenClawConfig(stateDir, ...)                  openclaw-adapter.ts → writeOpenClawConfig
         writes stateDir/openclaw.json  (OpenClawConfig)
         config shape:
           agents.defaults.model.primary = modelId ?? "openai-codex/gpt-5.4"
           agents.defaults.workspace = stateDir/workspace
           channels.moltzap.accounts[0] = { apiKey, serverUrl, agentName }
           gateway.mode = "local"
           gateway.auth.token = "runtime-<timestamp_base36>"
       seedWorkspaceFiles(stateDir, input.workspaceFiles)  openclaw-adapter.ts → seedWorkspaceFiles
       installChannelPlugin(stateDir, channelDistDir,       openclaw-adapter.ts → installChannelPlugin
                            repoRoot)
         resolves `effect` dep via resolveChannelDependency
         installs openclaw-channel as plugin via
           openclaw.plugin.json manifest

  3. buildOpenClawProcessPlan(openclawBin, port)           openclaw-adapter.ts → buildOpenClawProcessPlan
       If openclawBin.endsWith(".mjs"):
         command = "node"  args = [openclawBin, "gateway",
           "run", "--allow-unconfigured", "--port", port]
       Else:
         command = openclawBin  args = ["gateway", "run",
           "--allow-unconfigured", "--port", port]

  4. spawnOpenClawProcess(command, args, cwd=stateDir,     openclaw-adapter.ts → spawnOpenClawProcess
       env = {
         OPENCLAW_STATE_DIR: stateDir,
         OPENCLAW_CONFIG_PATH: stateDir/openclaw.json
       })
       Scope.make() → Command.start() → Scope.extend(scope)
       exitFiber = proc.exitCode.forkIn(scope)
       stdout + stderr fibers → logBuffer.value

  5. this.state = { process, stateDir, logBuffer,
                    spawnInput, tornDown: false }

Readiness (OpenClawAdapter.waitUntilReady):             openclaw-adapter.ts → OpenClawAdapter.waitUntilReady
  Race:
    server.awaitAgentReady(agentId, timeoutMs)
      (openclaw's moltzap channel authenticates on WS connect)
    processExitLoop({ pollExitCode: () => Fiber.poll(exitFiber),
                      stderr: () => logBuffer.value })
  Binary: "openclaw" (native) or "node <openclaw.mjs>" (mjs)
  Readiness signal: server-side WS authentication event
    (NOT a stdout pattern — openclaw dials moltzap on startup)
  Inbound marker: "inbound from agent:"              openclaw-adapter.ts → inbound log marker
```

## 3.2 Nanoclaw Adapter (`nanoclaw-adapter.ts` + `nanoclaw-process.ts`)

Nanoclaw is unique: it runs agent subprocesses **inside Docker containers**
via the OneCLI gateway. The adapter has a two-phase startup: first ensure the
runtime cache is installed, then launch.

```text
NanoclawAdapter.spawn(input)                           nanoclaw-adapter.ts → NanoclawAdapter.spawn

  Phase 1 — ensureNanoclawRuntimeInstalledEffect()     nanoclaw-process.ts → ensureNanoclawRuntimeInstalledEffect
    Checks ~/.cache/moltzap-runtimes/nanoclaw/<sha12>/.ready
    If .ready exists:
      syncChannelFileIntoCache()                        nanoclaw-process.ts → syncChannelFileIntoCache
        diffs packages/nanoclaw-channel/src/channels/moltzap.ts
        diffs packages/client/dist/channel-core.js
        if either drifted: overwrite cache + npm run build
    Else (cold install):
      preflightDocker()                                 nanoclaw-process.ts → preflightDocker
        execEffect("docker info", timeout=5000ms)
      downloadTarball(NANOCLAW_URL, tmpDir)             nanoclaw-process.ts → downloadTarball
        curl -fsSL <github tarball> -o nanoclaw.tar.gz
        tar -xzf ... --strip-components=1
        NANOCLAW_SHA = qwibitai/nanoclaw@934f063...     nanoclaw-process.ts → NANOCLAW_SHA
      copyChannelFileIntoCache(tmpDir)                  nanoclaw-process.ts → copyChannelFileIntoCache
      appendMoltzapBarrelImport(tmpDir)                 nanoclaw-process.ts → appendMoltzapBarrelImport
      copySharedSkillIntoCache(tmpDir)                  nanoclaw-process.ts → copySharedSkillIntoCache
      buildNanoclawRuntimeCache(tmpDir)                 nanoclaw-process.ts → buildNanoclawRuntimeCache
        npm install @moltzap/client@latest (120s)
        npm install (300s)
        npm run build (120s)
        bash container/build.sh (300s)
      promoteRuntimeCache(tmpDir → NANOCLAW_RUNTIME_CACHE)

  Phase 2 — startNanoclawRuntimeEffect(opts)           nanoclaw-process.ts → startNanoclawRuntimeEffect
    createNanoclawDataDir()  (mktemp prefix=moltzap-nanoclaw-runtime-)
    ensureOnecliRunning()                               nanoclaw-process.ts → ensureOnecliRunning
      probe http://127.0.0.1:10254 (timeout=2s)
      if unreachable: docker compose -p onecli up -d --wait
      probe up to 20×500ms
    writeRuntimeWorkspaceFiles(workspaceFiles)
      → NANOCLAW_RUNTIME_CACHE/container/skills/<path>

    startNanoclawProcess(opts, dataDir, capturedLogs)   nanoclaw-process.ts → startNanoclawProcess
      command: "node dist/index.js"
      cwd: NANOCLAW_RUNTIME_CACHE
      env = {
        MOLTZAP_API_KEY: apiKey,
        MOLTZAP_SERVER_URL: <http-normalized>,
        MOLTZAP_EVAL_MODE: "1",
        DATA_DIR: dataDir,
        CONTAINER_RUNTIME: "docker",
        ONECLI_URL: "http://127.0.0.1:10254",
        LOG_LEVEL: "info"
      }

    waitForNanoclawConnection(exitFiber, capturedLogs)  nanoclaw-process.ts → waitForNanoclawConnection
      Race (timeout=60s):
        waitForConnectedMarker: poll every 200ms,
          scan capturedLogs for CONNECTED_MARKER regex     nanoclaw-process.ts → CONNECTED_MARKER
          /\[info\].*MoltZap connected|MoltZap connected/
        failIfProcessExitsBeforeConnect: Fiber.join(exitFiber)

  this.state = { handle, spawnInput, tornDown: false }

Readiness (NanoclawAdapter.waitUntilReady):             nanoclaw-adapter.ts → NanoclawAdapter.waitUntilReady
  Note: nanoclaw has TWO readiness gates:
    1. Inner: waitForNanoclawConnection (stdout marker,
              inside startNanoclawRuntimeEffect)
    2. Outer: server.awaitAgentReady (server WS auth,
              inside waitUntilReady)
  Outer race:
    server.awaitAgentReady(agentId, timeoutMs)
    processExitLoop({ pollExitCode: () =>
      Fiber.poll(handle.exitFiber), stderr: () =>
      getNanoclawRuntimeLogs(handle) })
  Binary: "node dist/index.js" in NANOCLAW_RUNTIME_CACHE
  Inbound marker: "New messages"                        nanoclaw-adapter.ts → inbound log marker
```

## 3.3 ClaudeCode Adapter (`claude-code-adapter.ts`)

```text
ClaudeCodeAdapter.spawn(input)                         claude-code-adapter.ts → ClaudeCodeAdapter.spawn

  1. prepareClaudeCodeStateDir(deps, input)            claude-code-adapter.ts → prepareClaudeCodeStateDir
       makeTempDirectory({ prefix: "claude-code-<agentName>-" })
       seedWorkspaceFiles(stateDir, input.workspaceFiles)
       installClaudeCodeChannelPlugin(deps, stateDir)   claude-code-adapter.ts → installClaudeCodeChannelPlugin
         resolves @modelcontextprotocol/sdk and effect deps
         via resolveChannelDependency (parent node_modules walk)
         installs claude-code-channel (no openclaw.plugin.json —
         cc-channel has no OpenClaw manifest equivalent)
         returns extDir (path to channel inside stateDir)

  2. writeClaudeCodeMcpConfig(opts)                    claude-code-process.ts → writeClaudeCodeMcpConfig
       serverUrl normalized: strip /ws, ws→http, wss→https
       channelServerName = "@moltzap/claude-code-channel/<agentName>"
       writes stateDir/mcp-config.json:
         { mcpServers: {
             moltzap: {
               command: "node",
               args: [extDir/dist/cli.js],
               env: {
                 MOLTZAP_API_KEY: apiKey,
                 MOLTZAP_SERVER_URL: serverUrl,
                 MOLTZAP_SERVER_NAME: channelServerName
               }
             }
           }
         }
       returns configPath

  3. spawnConfiguredClaude(deps, stateDir, mcpConfigPath, logBuffer)
       buildClaudeArgs(path, stateDir, mcpConfigPath):    claude-code-adapter.ts → buildClaudeArgs
         "--strict-mcp-config"
         "--mcp-config"  <mcpConfigPath>
         "--print"
         "--input-format" "stream-json"
         "--output-format" "stream-json"
         "--verbose"
         "--dangerously-skip-permissions"
         "--add-dir" <stateDir/workspace>
       spawnClaudeProcess(claudeBin, args,                claude-code-adapter.ts → spawnClaudeProcess
         cwd=stateDir,
         env={ CLAUDE_CODE_HOME: stateDir },
         stdin="inherit")
       Scope.make() → Command.start() → Scope.extend(scope)
       exitFiber = proc.exitCode.forkIn(scope)
       stdout + stderr fibers → logBuffer.value

  4. this.state = { process, stateDir, spawnInput,
                    logBuffer, tornDown: false }

Readiness (ClaudeCodeAdapter.waitUntilReady):          claude-code-adapter.ts → ClaudeCodeAdapter.waitUntilReady
  Race:
    server.awaitAgentReady(agentId, timeoutMs)
      (cc-channel's MCP stdio server authenticates on start)
    processExitLoop({ pollExitCode: () =>
      pollClaudeExitCode(proc), stderr: () => logBuffer.value })
  Binary: claudeBin ("claude" CLI, @anthropic-ai/claude-code)
  Claude spawns cc-channel as MCP stdio child automatically
    (SIGTERM on claude propagates to cc-channel naturally —
     no process-group kill needed, unlike openclaw)
  Readiness signal: server-side WS authentication event
  Inbound marker: "notifications/claude/channel"        claude-code-adapter.ts → inbound log marker
    (cc-channel sends MCP notifications/claude/channel
     for each inbound message; visible in --verbose output)
```

## See Also

- [Single-Runtime Startup](./01-single-runtime-startup.md)
- [Workspace Path Resolution](./04-workspace-path-resolution.md)
- [Shutdown Propagation](./05-shutdown-propagation.md)
- [Process State Machine](./07-process-state-machine.md)
