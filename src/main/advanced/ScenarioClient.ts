/**
 * Single-request executor for the advanced scenarios.
 *
 * The plan's Python engine relies on evalscope to stream an OpenAI-compatible
 * endpoint and timestamp each token. The desktop tool already owns that
 * primitive (`SshSession.requestStreamLines`, used by `BenchmarkRunner`), so the
 * port reuses it instead of shelling out to Python: one request in, one
 * `ScenarioRequestOutcome` out, with per-token inter-arrival times retained so
 * TPOT/ITL can be derived exactly as the plan defines them.
 */

import { performance } from "node:perf_hooks";
import type { ScenarioRequestOutcome } from "../../shared/AdvancedScenarios";
import type { OllamaEnvironment, OllamaGenerateDone } from "../../shared/types";
import { isOpenAiCompatibleBackend } from "../../shared/types";
import { classifyError } from "./AdvancedStats";
import { estimateTokens } from "./AdvancedFiller";

/** Structural subset of `SshSession`, so scenarios stay unit-testable. */
export type StreamingTransport = {
  requestStreamLines: (
    request: { host: string; port: number; path: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal },
    onLine: (value: unknown) => void,
  ) => Promise<void>;
};

export type ScenarioRequestOptions = {
  model: string;
  prompt: string;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  /** Wall-clock offset from the scenario start, used for time bucketing. */
  startOffsetMs?: number;
  /** Forces `num_ctx` on the Ollama backend so a context probe is honest. */
  numCtx?: number;
  signal?: AbortSignal;
};

function openAiText(chunk: OllamaGenerateDone): string | undefined {
  const choice = chunk.choices?.[0];
  return choice?.delta?.content
    ?? choice?.delta?.reasoning_content
    ?? choice?.text
    ?? choice?.message?.content
    ?? choice?.message?.reasoning_content;
}

function chunkText(chunk: OllamaGenerateDone): string {
  return [chunk.response, chunk.message?.content, openAiText(chunk)]
    .filter((value): value is string => typeof value === "string")
    .join("");
}

function isTokenChunk(chunk: OllamaGenerateDone): boolean {
  return [chunk.response, chunk.thinking, chunk.message?.content, chunk.message?.thinking, openAiText(chunk)]
    .some((value) => typeof value === "string" && value.length > 0);
}

function isCompletionChunk(chunk: OllamaGenerateDone): boolean {
  return Boolean(chunk.done || chunk.usage || chunk.timings || chunk.choices?.some((choice) => choice.finish_reason));
}

export class ScenarioClient {
  public constructor(
    private readonly transport: StreamingTransport,
    private readonly environment: OllamaEnvironment,
    private readonly now: () => number = () => performance.now(),
  ) {}

  public async execute(options: ScenarioRequestOptions): Promise<ScenarioRequestOutcome> {
    const llama = isOpenAiCompatibleBackend(this.environment.backend);
    const startOffsetMs = options.startOffsetMs ?? 0;
    const startedAt = this.now();
    const interTokenLatenciesMs: number[] = [];
    let firstTokenAt: number | undefined;
    let previousTokenAt: number | undefined;
    let lastTokenAt: number | undefined;
    let streamedTokens = 0;
    let text = "";
    let done: OllamaGenerateDone | undefined;
    let lastChunk: OllamaGenerateDone | undefined;
    let streamError: string | undefined;

    try {
      const body = llama
        ? {
            model: options.model,
            messages: [{ role: "user", content: options.prompt }],
            stream: true,
            max_tokens: options.maxOutputTokens,
            temperature: options.temperature,
            stream_options: { include_usage: true },
          }
        : {
            model: options.model,
            prompt: options.prompt,
            stream: true,
            think: false,
            keep_alive: "30m",
            options: {
              num_predict: options.maxOutputTokens,
              temperature: options.temperature,
              ...(options.numCtx === undefined ? {} : { num_ctx: options.numCtx }),
            },
          };

      await this.transport.requestStreamLines(
        {
          host: this.environment.apiHost,
          port: this.environment.apiPort,
          path: llama ? "/v1/chat/completions" : "/api/generate",
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          body,
        },
        (value) => {
          const chunk = value as OllamaGenerateDone;
          lastChunk = chunk;
          if (!streamError && typeof chunk.error === "string" && chunk.error) streamError = chunk.error;
          if (isTokenChunk(chunk)) {
            const at = this.now();
            streamedTokens += 1;
            text += chunkText(chunk);
            if (firstTokenAt === undefined) firstTokenAt = at;
            else if (previousTokenAt !== undefined) interTokenLatenciesMs.push(at - previousTokenAt);
            previousTokenAt = at;
            lastTokenAt = at;
          }
          if (isCompletionChunk(chunk)) done = chunk;
        },
      );

      if (streamError) throw new Error(streamError);
      done ??= lastChunk;
      if (!done) throw new Error("empty response: no completion chunk");
      if (firstTokenAt === undefined) throw new Error("empty response: no streamed token");

      const completedAt = this.now();
      const outputTokens = done.eval_count ?? done.usage?.completion_tokens ?? done.timings?.predicted_n ?? streamedTokens;
      const inputTokens = done.prompt_eval_count
        ?? done.usage?.prompt_tokens
        ?? done.timings?.prompt_n
        ?? estimateTokens(options.prompt);

      return {
        ok: true,
        startOffsetMs,
        ttftMs: firstTokenAt - startedAt,
        e2eMs: (lastTokenAt ?? completedAt) - startedAt,
        inputTokens,
        outputTokens,
        interTokenLatenciesMs,
        finishReason: done.choices?.[0]?.finish_reason ?? (done.done ? "stop" : undefined),
        responseText: text,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        startOffsetMs,
        interTokenLatenciesMs,
        responseText: text,
        errorKind: classifyError(message, { aborted: options.signal?.aborted }),
        errorMessage: message,
      };
    }
  }
}
