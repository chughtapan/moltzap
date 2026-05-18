export function postJson(
  url: string,
  opts: {
    readonly body: string;
    readonly headers: Record<string, string>;
    readonly signal: AbortSignal;
  },
): ReturnType<typeof fetch> {
  return fetch(url, {
    method: "POST",
    headers: opts.headers,
    body: opts.body,
    signal: opts.signal,
  });
}
