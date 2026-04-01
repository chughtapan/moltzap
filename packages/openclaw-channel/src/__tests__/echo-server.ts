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

export type EchoServer = { port: number; close: () => void };

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

export function startEchoServer(): Promise<EchoServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) bodyChunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(bodyChunks).toString();

      if (process.env.ECHO_DEBUG) {
        console.log(`[echo-server] ${req.method} ${req.url}`);
      }

      // Model listing (OpenClaw may probe this)
      if (
        (req.url === "/v1/models" || req.url === "/models") &&
        req.method === "GET"
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "echo-1", object: "model", owned_by: "echo" }],
          }),
        );
        return;
      }

      // Only handle chat completions
      const isCompletions =
        req.method === "POST" &&
        (req.url === "/v1/chat/completions" || req.url === "/chat/completions");
      if (!isCompletions) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      let body: ChatCompletionCreateParams;
      try {
        body = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Malformed JSON body" }));
        return;
      }

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or empty messages array" }));
        return;
      }

      const userText = extractUserText(body);
      const content = `ECHO: ${userText}`;
      const completionId = `chatcmpl-echo-${Date.now()}`;

      if (process.env.ECHO_DEBUG) {
        const userMsgs = body.messages
          .filter((m) => m.role === "user")
          .map((m) => {
            const c =
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content);
            return `${c.slice(0, 80)}(${c.length})`;
          });
        console.log(
          `[echo-server] stream=${!!body.stream} userMsgs=[${userMsgs}] replyLen=${content.length}`,
        );
      }

      if (body.stream) {
        // SSE streaming response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const contentChunk: ChatCompletionChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "echo-1",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);

        const stopChunk: ChatCompletionChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "echo-1",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        // Non-streaming response
        const completion: ChatCompletion = {
          id: completionId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "echo-1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content, refusal: null },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(completion));
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
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
