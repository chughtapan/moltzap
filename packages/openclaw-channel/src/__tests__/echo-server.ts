/**
 * OpenAI-compatible HTTP server for integration tests.
 * Supports both streaming (SSE) and non-streaming responses.
 * Returns "ECHO: {last user message}" in chat completions format.
 */

import http from "node:http";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionContentPartText,
} from "openai/resources/chat/completions";
import { Config, ConfigProvider, Effect, Option } from "effect";

export type EchoServer = { port: number; close: () => void };

export interface EchoServerOptions {
  readonly debug?: boolean;
}

const EchoDebug = Config.option(Config.string("ECHO_DEBUG"));
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const MS_PER_SECOND = 1000;
const DEBUG_MESSAGE_PREVIEW_CHARS = 80;
const ECHO_MODEL_ID = "echo-1";
const CHAT_COMPLETION_OBJECT = "chat.completion";
const CHAT_COMPLETION_CHUNK_OBJECT = "chat.completion.chunk";
const STOP_FINISH_REASON = "stop";
const JSON_ERROR_NOT_FOUND = "Not found";
const JSON_ERROR_MALFORMED_BODY = "Malformed JSON body";
const JSON_ERROR_EMPTY_MESSAGES = "Missing or empty messages array";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

class EchoServerError extends Error {
  override readonly name = "EchoServerError";
}

function readEchoDebug(): boolean {
  const raw = Option.getOrUndefined(
    Effect.runSync(
      EchoDebug.pipe(Effect.withConfigProvider(ConfigProvider.fromEnv())),
    ),
  );
  return raw !== undefined && raw !== "" && raw !== "0" && raw !== "false";
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function writeJsonError(
  res: http.ServerResponse,
  statusCode: number,
  error: string,
): void {
  writeJson(res, statusCode, { error });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / MS_PER_SECOND);
}

function makeCompletionId(): string {
  return `chatcmpl-echo-${Date.now()}`;
}

function makeCompletionMetadata(id: string) {
  return {
    id,
    created: nowSeconds(),
    model: ECHO_MODEL_ID,
  };
}

function isModelListRequest(req: http.IncomingMessage): boolean {
  return (
    (req.url === "/v1/models" || req.url === "/models") && req.method === "GET"
  );
}

function isChatCompletionRequest(req: http.IncomingMessage): boolean {
  return (
    req.method === "POST" &&
    (req.url === "/v1/chat/completions" || req.url === "/chat/completions")
  );
}

function writeModelList(res: http.ServerResponse): void {
  writeJson(res, HTTP_OK, {
    object: "list",
    data: [{ id: ECHO_MODEL_ID, object: "model", owned_by: "echo" }],
  });
}

function extractUserText(params: ChatCompletionCreateParams): string {
  const lastUserMsg = [...params.messages]
    .reverse()
    .find((m) => m.role === "user");
  if (!lastUserMsg) return "";

  const rawContent = lastUserMsg.content;
  if (typeof rawContent === "string") return rawContent;
  if (!Array.isArray(rawContent)) return "";

  return rawContent
    .filter(
      (part): part is ChatCompletionContentPartText => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function formatDebugUserMessages(params: ChatCompletionCreateParams): string[] {
  return params.messages
    .filter((m) => m.role === "user")
    .map((m) => {
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${content.slice(0, DEBUG_MESSAGE_PREVIEW_CHARS)}(${content.length})`;
    });
}

function makeContentChunk(params: {
  readonly id: string;
  readonly content: string;
}): ChatCompletionChunk {
  return {
    ...makeCompletionMetadata(params.id),
    object: CHAT_COMPLETION_CHUNK_OBJECT,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: params.content },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

function makeStopChunk(id: string): ChatCompletionChunk {
  return {
    ...makeCompletionMetadata(id),
    object: CHAT_COMPLETION_CHUNK_OBJECT,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: STOP_FINISH_REASON,
        logprobs: null,
      },
    ],
  };
}

function makeCompletion(params: {
  readonly id: string;
  readonly content: string;
}): ChatCompletion {
  return {
    ...makeCompletionMetadata(params.id),
    object: CHAT_COMPLETION_OBJECT,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: params.content, refusal: null },
        finish_reason: STOP_FINISH_REASON,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function writeSseChunk(
  res: http.ServerResponse,
  chunk: ChatCompletionChunk,
): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function writeStreamingCompletion(
  res: http.ServerResponse,
  params: { readonly id: string; readonly content: string },
): void {
  res.writeHead(HTTP_OK, SSE_HEADERS);
  writeSseChunk(res, makeContentChunk(params));
  writeSseChunk(res, makeStopChunk(params.id));
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeChatCompletion(
  res: http.ServerResponse,
  body: ChatCompletionCreateParams,
  debug: boolean,
): void {
  const userText = extractUserText(body);
  const content = `ECHO: ${userText}`;
  const completionId = makeCompletionId();

  if (debug) {
    const userMsgs = formatDebugUserMessages(body);
    console.log(
      `[echo-server] stream=${!!body.stream} userMsgs=[${userMsgs}] replyLen=${content.length}`,
    );
  }

  if (body.stream) {
    writeStreamingCompletion(res, { id: completionId, content });
    return;
  }

  writeJson(res, HTTP_OK, makeCompletion({ id: completionId, content }));
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string,
  debug: boolean,
): void {
  if (debug) {
    console.log(`[echo-server] ${req.method} ${req.url}`);
  }

  if (isModelListRequest(req)) {
    writeModelList(res);
    return;
  }

  if (!isChatCompletionRequest(req)) {
    writeJsonError(res, HTTP_NOT_FOUND, JSON_ERROR_NOT_FOUND);
    return;
  }

  let body: ChatCompletionCreateParams;
  try {
    body = JSON.parse(rawBody);
  } catch (cause) {
    void cause;
    writeJsonError(res, HTTP_BAD_REQUEST, JSON_ERROR_MALFORMED_BODY);
    return;
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    writeJsonError(res, HTTP_BAD_REQUEST, JSON_ERROR_EMPTY_MESSAGES);
    return;
  }

  writeChatCompletion(res, body, debug);
}

export function startEchoServer(options: EchoServerOptions = {}) {
  const debug = options.debug ?? readEchoDebug();
  return new Promise<EchoServer>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const bodyChunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
      req.on("error", reject);
      req.on("end", () => {
        const rawBody = Buffer.concat(bodyChunks).toString();
        handleRequest(req, res, rawBody, debug);
      });
    });

    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new EchoServerError("Failed to get server address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => server.close(),
      });
    });

    server.on("error", reject);
  });
}
