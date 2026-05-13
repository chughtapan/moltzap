export function isStandaloneDirectRun(argv: readonly string[]): boolean {
  return (
    argv[1]?.endsWith("standalone.js") === true ||
    argv[1]?.endsWith("standalone.ts") === true
  );
}

export function currentArgv(): readonly string[] {
  return process.argv;
}
