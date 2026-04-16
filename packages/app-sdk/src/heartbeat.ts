/**
 * Application-level heartbeat using system/ping RPC.
 * Triggers onFailure when a ping times out or errors.
 */
export class HeartbeatManager {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(
    sendPing: () => Promise<void>,
    intervalMs: number,
    onFailure: (err: Error) => void,
  ): void {
    this.stop();
    this.timer = setInterval(async () => {
      try {
        await sendPing();
      } catch (err) {
        onFailure(err instanceof Error ? err : new Error(String(err)));
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  destroy(): void {
    this.stop();
  }
}
