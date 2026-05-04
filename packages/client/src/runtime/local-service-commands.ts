export const LocalServiceCommands = {
  Ping: "ping",
  Status: "status",
  History: "history",
} as const;

export type LocalServiceCommand =
  (typeof LocalServiceCommands)[keyof typeof LocalServiceCommands];
