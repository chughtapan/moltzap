/** Webhook adapters for calling external services over HTTP. */

// -- Semaphore ----------------------------------------------------------------

class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}

// -- Sync webhook client (Users, Contacts) ------------------------------------

export class WebhookClient {
  private semaphore: Semaphore;

  constructor(concurrency = 10) {
    this.semaphore = new Semaphore(concurrency);
  }

  async callSync<T>(opts: {
    url: string;
    event: string;
    body: unknown;
    timeoutMs: number;
  }): Promise<T> {
    await this.semaphore.acquire();
    try {
      const response = await fetch(opts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MoltZap-Event": opts.event,
        },
        body: JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new WebhookError(
          `Webhook ${opts.event} returned ${response.status}: ${text}`,
          response.status,
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof WebhookError) throw err;
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new WebhookError(
          `Webhook ${opts.event} timed out after ${opts.timeoutMs}ms`,
          0,
        );
      }
      throw new WebhookError(
        `Webhook ${opts.event} failed: ${(err as Error).message}`,
        0,
      );
    } finally {
      this.semaphore.release();
    }
  }
}

// -- Async webhook adapter (Permissions) --------------------------------------

interface PendingRequest {
  resolve: (access: string[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RESOLVED_TTL_MS = 5 * 60 * 1000;

export class AsyncWebhookAdapter {
  private pending = new Map<string, PendingRequest>();
  private resolved = new Map<string, number>();
  private semaphore: Semaphore;

  constructor(concurrency = 10) {
    this.semaphore = new Semaphore(concurrency);
  }

  async sendRequest(opts: {
    url: string;
    requestId: string;
    callbackUrl: string;
    callbackToken: string;
    body: unknown;
    timeoutMs: number;
  }): Promise<string[]> {
    await this.semaphore.acquire();
    try {
      const response = await fetch(opts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MoltZap-Event": "permissions.check",
          "X-MoltZap-Callback-URL": opts.callbackUrl,
          "X-MoltZap-Callback-Token": opts.callbackToken,
        },
        body: JSON.stringify({
          request_id: opts.requestId,
          ...(opts.body as object),
        }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });

      if (response.status !== 202) {
        const text = await response.text().catch(() => "");
        throw new WebhookError(
          `Permissions webhook expected 202, got ${response.status}: ${text}`,
          response.status,
        );
      }
    } finally {
      this.semaphore.release();
    }

    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(opts.requestId);
        reject(
          new WebhookError(
            `Permissions callback for ${opts.requestId} timed out after ${opts.timeoutMs}ms`,
            0,
          ),
        );
      }, opts.timeoutMs);

      this.pending.set(opts.requestId, { resolve, reject, timer });
    });
  }

  resolveCallback(requestId: string, access: string[]): boolean {
    // Idempotency: already resolved within TTL
    const resolvedAt = this.resolved.get(requestId);
    if (resolvedAt !== undefined) {
      if (Date.now() - resolvedAt < RESOLVED_TTL_MS) return true;
      this.resolved.delete(requestId);
      return false;
    }

    const entry = this.pending.get(requestId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.resolved.set(requestId, Date.now());
    entry.resolve(access);

    this.pruneResolved();
    return true;
  }

  destroy(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new WebhookError("Adapter destroyed", 0));
    }
    this.pending.clear();
    this.resolved.clear();
  }

  private pruneResolved(): void {
    const cutoff = Date.now() - RESOLVED_TTL_MS;
    for (const [id, ts] of this.resolved) {
      if (ts < cutoff) this.resolved.delete(id);
    }
  }
}

// -- Shared error type --------------------------------------------------------

export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}
