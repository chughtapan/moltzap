**Breaking:** `@moltzap/client/service` exports the daemon process composition as
`Daemon` instead of `MoltZapService`, and its startup failure is tagged
`DaemonStartupError` instead of `MoltZapServiceStartupError`; replace
`MoltZapService.layer`, `MoltZapService.withFirewall`,
`MoltZapService.FirewallOptions` and `MoltZapService.StartupError` with the
same members of `Daemon`. Package names, executables, environment
variables, persisted names, channel ids and wire constants are unchanged.
