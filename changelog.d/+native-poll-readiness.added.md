Add optional Client polling readiness after consumer acquisition and lease
renewal startup. Native Instinct and Grok receivers can select outbound MCP
Events polling without a public callback route, using the existing wake and
acknowledgment path. Existing webhook defaults remain unchanged.
