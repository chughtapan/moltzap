/* eslint-disable @typescript-eslint/naming-convention -- These quoted fields mirror OpenAI's JSON wire contract exactly. */
/**
 * Minimal OpenAI chat-completions wire shapes the echo server reads and
 * writes. Only the fields this test server touches are modeled; the real
 * `openai` SDK types carry dozens of optional fields the echo path never
 * inspects, so depending on the package for four structural types is debt.
 */

/**
 * A `{ type: "text", text }` content part — the only part shape the echo
 * server extracts user text from.
 */
export interface ChatCompletionContentPartText {
  readonly type: "text";
  readonly text: string;
}

interface ChatCompletionMessageParam {
  readonly role: string;
  readonly content: string | ReadonlyArray<{ readonly type: string }>;
}

/**
 * Inbound request body. The echo server reads `messages` (to find the last
 * user message) and `stream` (to choose SSE vs JSON).
 */
export interface ChatCompletionCreateParams {
  readonly messages: readonly ChatCompletionMessageParam[];
  readonly stream?: boolean | null;
}

/** Non-streaming response body. */
export interface ChatCompletion {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly object: "chat.completion";
  readonly choices: ReadonlyArray<{
    readonly index: number;
    readonly message: {
      readonly role: "assistant";
      readonly content: string;
      readonly refusal: null;
    };
    readonly finish_reason: string;
    readonly logprobs: null;
  }>;
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

/** Streaming response chunk (SSE `data:` payload). */
export interface ChatCompletionChunk {
  readonly id: string;
  readonly created: number;
  readonly model: string;
  readonly object: "chat.completion.chunk";
  readonly choices: ReadonlyArray<{
    readonly index: number;
    readonly delta: {
      readonly role?: "assistant";
      readonly content?: string;
    };
    readonly finish_reason: string | null;
    readonly logprobs: null;
  }>;
}

/* eslint-enable @typescript-eslint/naming-convention -- Restore strict defaults after the external wire contract. */
