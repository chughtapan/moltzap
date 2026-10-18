Breaking: `@moltzap/client/service` exports the daemon process composition as
`HarnessService` instead of `MoltZapService`, and its startup failure is tagged
`HarnessServiceStartupError` instead of `MoltZapServiceStartupError`; replace
`MoltZapService.layer`, `MoltZapService.withFirewall`,
`MoltZapService.FirewallOptions` and `MoltZapService.StartupError` with the
same members of `HarnessService`. Package names, executables, environment
variables, persisted names, channel ids and wire constants are unchanged.
