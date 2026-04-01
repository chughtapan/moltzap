import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startEchoServer, type EchoServer } from "./echo-server.js";

describe("echo-server", () => {
  let server: EchoServer;

  beforeAll(async () => {
    server = await startEchoServer();
  });

  afterAll(() => {
    server.close();
  });

  it("returns correct OpenAI response shape with ECHO: prefix", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello world" }],
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      object: "chat.completion",
      model: "echo-1",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ECHO: hello world" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(body.id).toMatch(/^chatcmpl-echo-/);
    expect(typeof body.created).toBe("number");
  });

  it("returns 400 for malformed body", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 404 for wrong endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "GET",
    });

    expect(res.status).toBe(404);
  });

  it("assigns a random port and shuts down cleanly", async () => {
    const second = await startEchoServer();
    expect(second.port).toBeGreaterThan(0);
    expect(second.port).not.toBe(server.port);
    second.close();
  });

  it("handles concurrent requests correctly", async () => {
    const messages = ["alpha", "bravo", "charlie", "delta", "echo"];
    const results = await Promise.all(
      messages.map((msg) =>
        fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: msg }],
          }),
        }).then((r) => r.json()),
      ),
    );

    for (let i = 0; i < messages.length; i++) {
      expect(results[i].choices[0].message.content).toBe(
        `ECHO: ${messages[i]}`,
      );
    }
  });
});
