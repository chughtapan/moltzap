# Loopback MCP

This folder owns the daemon's loopback MCP edge: the HTTP listener, the tool
catalog that projects Harness operations and private management tools, the
closed wire schemas, one runtime credential, and the experimental MCP Events
extension with push, native polling and webhook delivery. Authenticated remote
mode binds the management handler to a filesystem-protected Unix socket; both
listeners share Client state without sharing management authority.

The service composes these modules; hosts reach them only through
`HarnessEndpoint` or the MCP URL.
