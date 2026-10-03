/** @file The package version both loopback MCP peers report as their implementation version. */

import packageJson from "../../package.json" with { type: "json" };

/** The `@moltzap/client` package version, reported in MCP implementation info. */
export const packageVersion: string = packageJson.version;
