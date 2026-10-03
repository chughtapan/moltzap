# Loopback MCP

This folder owns the daemon's loopback MCP edge: the HTTP listener, the tool
catalog that projects Harness operations and owner tools, the closed wire
schemas, credential roles, and the experimental MCP Events extension with its
webhook delivery.

The service composes these modules; hosts reach them only through
`HarnessEndpoint` or the MCP URL.
