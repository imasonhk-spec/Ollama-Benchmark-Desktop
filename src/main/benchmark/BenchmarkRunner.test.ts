import { describe, expect, it, vi } from "vitest";
import type { BenchmarkConfig, OllamaEnvironment } from "../../shared/types";
import { BenchmarkRunner, getRequestTimeoutMs } from "./BenchmarkRunner";

const config: BenchmarkConfig = {
  models: ["demo"],
  inputLengths: [10],
  concurrencies: [2],
  rounds: 1,
  maxOutputTokens: 50,
  temperature: 0,
  warmupEnabled: false,
  timeoutMs: 1_000,
  contextWindow: "auto-fixed",
};

const environment: OllamaEnvironment = {
  deployment: "native",
  binary: "ollama",
  apiHost: "127.0.0.1",
  apiPort: 11434,
  gpuVendor: "none",
  gpuModels: [],
  installedModels: ["demo"],
  warnings: [],
};

describe("BenchmarkRunner", () => {
  it("keeps the configured timeout for small inputs and extends large-context allowance", () => {
    expect(getRequestTimeoutMs(16_000, 10, 600_000)).toBe(600_000);
    expect(getRequestTimeoutMs(64_000, 6, 600_000)).toBe(985_000);
    expect(getRequestTimeoutMs(64_000, 10, 600_000)).toBe(1_165_000);
  });

  it("runs one round with the configured concurrency and measures first token", async () => {
    let now = 100;
    const requestStreamLines = vi.fn(async (_request, onLine) => {
      now += 10;
      onLine({ response: "首 token" });
      now += 40;
      onLine({ done: true, prompt_eval_count: 10, prompt_eval_duration: 8_000_000, eval_count: 50, eval_duration: 5_000_000_000 });
    });
    const result = await new BenchmarkRunner({ requestStreamLines } as never, environment, () => now).run(config);

    expect(requestStreamLines).toHaveBeenCalledTimes(2);
    expect(result.samples).toHaveLength(2);
    expect(result.samples.every((sample) => sample.status === "success")).toBe(true);
    expect(result.samples[0].ttftMs).toBe(10);
    expect(result.samples[0].decodeTokensPerSecond).toBe(10);
    expect(result.summaries[0].successCount).toBe(2);
  });

  it("keeps failed requests in the result and does not reject the whole run", async () => {
    const requestStreamLines = vi.fn(async () => { throw new Error("offline"); });
    const result = await new BenchmarkRunner({ requestStreamLines } as never, environment, () => 0).run(config);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0].status).toBe("error");
    expect(result.summaries[0].failureCount).toBe(2);
    expect(result.cancelled).toBe(true);
  });
  it("continues only the unfinished samples", async () => {
    const requestStreamLines = vi.fn(async (_request, onLine) => {
      onLine({ response: "首 token" });
      onLine({ done: true, prompt_eval_count: 10, prompt_eval_duration: 8_000_000, eval_count: 50, eval_duration: 5_000_000_000 });
    });
    const previousSample = {
      model: "demo",
      targetInputTokens: 10,
      concurrency: 2,
      round: 1,
      workerIndex: 0,
      status: "success" as const,
      ttftMs: 10,
      decodeTokensPerSecond: 10,
      generatedTokens: 50,
    };

    const result = await new BenchmarkRunner({ requestStreamLines } as never, environment, () => 0).run(
      config,
      undefined,
      undefined,
      [previousSample],
    );

    expect(requestStreamLines).toHaveBeenCalledTimes(1);
    expect(result.samples).toHaveLength(2);
    expect(result.samples.every((sample) => sample.status === "success")).toBe(true);
    expect(result.summaries[0].successCount).toBe(2);
  });
});

it('uses the llama.cpp OpenAI-compatible streaming endpoint', async () => {
  const llamaEnvironment: OllamaEnvironment = { ...environment, backend: 'llama.cpp', apiPort: 8080, binary: 'llama-server' };
  const requestStreamLines = vi.fn(async (request, onLine) => {
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body).toMatchObject({ model: 'demo', stream: true, max_tokens: 50 });
    onLine({ choices: [{ delta: { content: '首 token' } }] });
    onLine({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 }, timings: { predicted_ms: 2_000, prompt_ms: 40 } });
  });
  const result = await new BenchmarkRunner({ requestStreamLines } as never, llamaEnvironment, () => 0).run({ ...config, concurrencies: [1] });
  expect(result.samples[0].status).toBe('success');
  expect(result.samples[0].generatedTokens).toBe(20);
  expect(result.samples[0].decodeTokensPerSecond).toBe(10);
});
it('sends only llama.cpp-supported OpenAI fields for performance requests', async () => {
  const llamaEnvironment: OllamaEnvironment = { ...environment, backend: 'llama.cpp', apiPort: 8080, binary: 'llama-server' };
  let receivedBody: Record<string, unknown> | undefined;
  const requestStreamLines = vi.fn(async (request, onLine) => {
    expect(request.path).toBe('/v1/chat/completions');
    receivedBody = request.body as Record<string, unknown>;
    onLine({ choices: [{ delta: { content: 'token' } }] });
    onLine({ choices: [{ finish_reason: 'stop' }], timings: { predicted_n: 1, predicted_ms: 100 } });
  });
  const result = await new BenchmarkRunner({ requestStreamLines } as never, llamaEnvironment, () => 0).run({ ...config, concurrencies: [1] });
  expect(result.samples[0].status).toBe('success');
  expect(receivedBody).not.toHaveProperty('n_ctx');
});

it('measures Decode (tok/s) client-side when llama.cpp reports no timing', async () => {
  const llamaEnvironment: OllamaEnvironment = { ...environment, backend: 'llama.cpp', apiPort: 8080, binary: 'llama-server' };
  let now = 0;
  let receivedBody: Record<string, unknown> | undefined;
  const requestStreamLines = vi.fn(async (request, onLine) => {
    receivedBody = request.body as Record<string, unknown>;
    now = 100; onLine({ choices: [{ delta: { content: 't' } }] });
    now = 300; onLine({ choices: [{ delta: { content: 't' } }] });
    now = 500; onLine({ choices: [{ delta: { content: 't' } }] });
    now = 1100; onLine({ choices: [{ delta: { content: 't' } }] });
    now = 1100; onLine({ choices: [{ finish_reason: 'stop' }] });
  });
  const result = await new BenchmarkRunner({ requestStreamLines } as never, llamaEnvironment, () => now).run({ ...config, concurrencies: [1] });
  const sample = result.samples[0];
  expect(sample.status).toBe('success');
  expect(receivedBody).toMatchObject({ stream_options: { include_usage: true } });
  expect(sample.generatedTokens).toBe(4);
  // 4 tokens generated over 1000ms (first token at 100ms, last at 1100ms) => 4 tok/s
  expect(sample.decodeTokensPerSecond).toBeCloseTo(4, 5);
});

it('uses the OpenAI-compatible endpoint for llama.cpp', async () => {
  const llamaEnv: OllamaEnvironment = { ...environment, backend: 'llama.cpp', apiPort: 8082, binary: 'llama-server' };
  const requestStreamLines = vi.fn(async (request, onLine) => {
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.body).toMatchObject({ model: 'demo', stream: true, max_tokens: 50 });
    onLine({ choices: [{ delta: { content: '首 token' } }] });
    onLine({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 }, timings: { predicted_ms: 2_000, prompt_ms: 40 } });
  });
  const result = await new BenchmarkRunner({ requestStreamLines } as never, llamaEnv, () => 0).run({ ...config, concurrencies: [1] });
  expect(result.samples[0].status).toBe('success');
  expect(result.samples[0].generatedTokens).toBe(20);
});

it('uses the OpenAI-compatible endpoint for a remote openai-compatible service', async () => {
  const remoteEnv: OllamaEnvironment = { ...environment, backend: 'openai-compatible', apiHost: '192.168.6.90', apiPort: 8000, binary: 'llama-server' };
  const requestStreamLines = vi.fn(async (request, onLine) => {
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.host).toBe('192.168.6.90');
    expect(request.body).toMatchObject({ model: 'demo', stream: true });
    onLine({ choices: [{ delta: { content: 't' } }] });
    onLine({ choices: [{ finish_reason: 'stop' }], timings: { predicted_n: 1, predicted_ms: 100 } });
  });
  const result = await new BenchmarkRunner({ requestStreamLines } as never, remoteEnv, () => 0).run({ ...config, concurrencies: [1] });
  expect(result.samples[0].status).toBe('success');
});

it('uses the Ollama /api/generate endpoint for ollama', async () => {
  const ollamaEnv: OllamaEnvironment = { ...environment, backend: 'ollama', apiPort: 11434, binary: 'ollama' };
  const requestStreamLines = vi.fn(async (request, onLine) => {
    expect(request.path).toBe('/api/generate');
    onLine({ response: '首 token' });
    onLine({ done: true, prompt_eval_count: 10, prompt_eval_duration: 8_000_000, eval_count: 50, eval_duration: 5_000_000_000 });
  });
  const result = await new BenchmarkRunner({ requestStreamLines } as never, ollamaEnv, () => 0).run({ ...config, concurrencies: [1] });
  expect(result.samples[0].status).toBe('success');
  expect(result.samples[0].generatedTokens).toBe(50);
});
