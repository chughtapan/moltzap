// safer-arch-ignore no-trivial-sink-file: this module is the CLI's explicit Node process boundary for obtaining argv at the runtime edge.
export const currentArgv = (): ReadonlyArray<string> => process.argv;
