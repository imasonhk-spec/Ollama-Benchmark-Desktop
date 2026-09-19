import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { benchmarkConfigSchema } from "../../shared/schemas";
import type { BenchmarkConfig, BenchmarkSample, BenchmarkSummary, OllamaEnvironment, OllamaGenerateDone } from "../../shared/types";
import { isOpenAiCompatibleBackend } from "../../shared/types";
import { createBenchmarkPrompt } from "./PromptFactory";
import { summarizeSamples } from "./MetricsCalculator";
import { SshSession } from "../ssh/SshSession";

export type BenchmarkProgress = { completed: number; total: number; model: string; inputLength: number; concurrency: number; round: number; sample?: BenchmarkSample };
export type BenchmarkRunResult = { startedAt: string; finishedAt: string; cancelled: boolean; config: BenchmarkConfig; samples: BenchmarkSample[]; summaries: BenchmarkSummary[] };

function nanosToMs(value: number | undefined): number | undefined { return value === undefined ? undefined : value / 1_000_000; }
function groupingKey(model: string, inputLength: number, concurrency: number): string { return `${model}\u0000${inputLength}\u0000${concurrency}`; }
function sampleKey(sample: Pick<BenchmarkSample, "model" | "targetInputTokens" | "concurrency" | "round" | "workerIndex">): string { return [sample.model, sample.targetInputTokens, sample.concurrency, sample.round, sample.workerIndex].join("\u0000"); }
function openAiText(chunk: OllamaGenerateDone): string | undefined {
  const choice = chunk.choices?.[0];
  return choice?.delta?.content ?? choice?.delta?.reasoning_content ?? choice?.text ?? choice?.message?.content ?? choice?.message?.reasoning_content;
}
function isTokenChunk(chunk: OllamaGenerateDone): boolean {
  return [chunk.response, chunk.thinking, chunk.message?.content, chunk.message?.thinking, openAiText(chunk)]
    .some((value) => typeof value === "string" && value.length > 0) || chunk.done === false;
}
function isCompletionChunk(chunk: OllamaGenerateDone): boolean {
  return Boolean(chunk.done || chunk.usage || chunk.timings || chunk.choices?.some((choice) => choice.finish_reason));
}
function decodeRate(chunk: OllamaGenerateDone, fallbackTokenCount: number): number | undefined {
  const count = chunk.eval_count ?? chunk.usage?.completion_tokens ?? chunk.timings?.predicted_n ?? fallbackTokenCount;
  const durationNs = chunk.eval_duration ?? (chunk.timings?.predicted_ms !== undefined ? chunk.timings.predicted_ms * 1_000_000 : undefined);
  if (!count || !durationNs || durationNs <= 0) return undefined;
  return count / (durationNs / 1_000_000_000);
}

/**
 * Client-side decode-speed fallback. The OpenAI-compatible streaming endpoint used by
 * llama.cpp does not report per-token timing (no `eval_duration`/`timings`), so when the
 * server provides no rate we measure it from the token timestamps we already captured:
 * generated tokens divided by the wall-clock time from the first token to completion.
 * This guarantees the Decode (tok/s) field is populated for llama.cpp sessions.
 */
function measureClientDecodeRate(opts: { generatedTokens: number; firstTokenAt?: number; lastTokenAt?: number; completedAt: number }): number | undefined {
  const { generatedTokens, firstTokenAt, lastTokenAt, completedAt } = opts;
  if (!generatedTokens || firstTokenAt === undefined) return undefined;
  const end = lastTokenAt ?? completedAt;
  const durationMs = end - firstTokenAt;
  if (durationMs <= 0) return undefined;
  return generatedTokens / (durationMs / 1_000);
}

/** Large contexts receive a bounded queue allowance so 32K/64K requests are not misclassified as network failures. */
export function getRequestTimeoutMs(inputLength: number, concurrency: number, configuredMs: number): number {
  if (inputLength < 32_000) return configuredMs;
  const contextAllowance = Math.round(inputLength * 10);
  const queueAllowance = Math.max(0, concurrency - 1) * 45_000;
  return Math.min(3_600_000, Math.max(configuredMs, 120_000 + contextAllowance + queueAllowance));
}

export class BenchmarkRunner {
  public constructor(private readonly ssh: SshSession, private readonly environment: OllamaEnvironment, private readonly now: () => number = () => performance.now()) {}

  public async run(rawConfig: BenchmarkConfig, onProgress?: (progress: BenchmarkProgress) => void, signal?: AbortSignal, previousSamples: BenchmarkSample[] = []): Promise<BenchmarkRunResult> {
    const config = benchmarkConfigSchema.parse(rawConfig);
    const startedAt = new Date().toISOString();
    const sampleByKey = new Map<string, BenchmarkSample>();
    for (const sample of previousSamples) sampleByKey.set(sampleKey(sample), sample);
    const successfulKeys = new Set(previousSamples.filter((sample) => sample.status === "success").map((sample) => sampleKey(sample)));
    const total = config.models.length * config.inputLengths.length * config.concurrencies.reduce((sum, value) => sum + value * config.rounds, 0);
    let completed = successfulKeys.size;
    let cancelled = false;

    for (const model of config.models) {
      if (config.warmupEnabled && previousSamples.length === 0 && !signal?.aborted) {
        try { await this.executeSample(model, 32, 1, 0, 0, config); } catch { /* warmup is excluded */ }
      }
      for (const inputLength of config.inputLengths) {
        for (const concurrency of config.concurrencies) {
          for (let round = 1; round <= config.rounds; round += 1) {
            if (signal?.aborted) { cancelled = true; break; }
            const pendingWorkers = Array.from({ length: concurrency }, (_, workerIndex) => workerIndex)
              .filter((workerIndex) => !successfulKeys.has(sampleKey({ model, targetInputTokens: inputLength, concurrency, round, workerIndex })));
            if (!pendingWorkers.length) continue;
            const roundSamples = await Promise.all(pendingWorkers.map((workerIndex) => this.executeSample(model, inputLength, concurrency, round, workerIndex, config, signal)));
            for (const sample of roundSamples) {
              const key = sampleKey(sample);
              sampleByKey.set(key, sample);
              if (sample.status === "success") successfulKeys.add(key);
              completed += 1;
              onProgress?.({ completed, total, model, inputLength, concurrency, round, sample });
            }
          }
          if (cancelled) break;
        }
        if (cancelled) break;
      }
      if (cancelled) break;
    }

    const samples = [...sampleByKey.values()];
    const groups = new Map<string, BenchmarkSample[]>();
    for (const sample of samples) { const key = groupingKey(sample.model, sample.targetInputTokens, sample.concurrency); groups.set(key, [...(groups.get(key) ?? []), sample]); }
    const summaries = [...groups.entries()].map(([key, group]) => { const [model, inputLength, concurrency] = key.split("\u0000"); return summarizeSamples(model, Number(inputLength), Number(concurrency), group); });
    const hasUnfinishedSamples = samples.length < total || samples.some((sample) => sample.status !== "success");
    return { startedAt, finishedAt: new Date().toISOString(), cancelled: cancelled || Boolean(signal?.aborted) || hasUnfinishedSamples, config, samples, summaries };
  }

  private async executeSample(model: string, targetInputTokens: number, concurrency: number, round: number, workerIndex: number, config: BenchmarkConfig, signal?: AbortSignal): Promise<BenchmarkSample> {
    const numCtx = config.contextWindow === "auto-fixed" ? targetInputTokens + config.maxOutputTokens + 1_024 : undefined;
    const prompt = createBenchmarkPrompt(targetInputTokens, randomUUID());
    const requestStarted = this.now();
    let firstTokenAt: number | undefined;
    let lastTokenAt: number | undefined;
    let done: OllamaGenerateDone | undefined;
    let lastChunk: OllamaGenerateDone | undefined;
    let streamError: string | undefined;
    let streamedTokenCount = 0;
    const llama = isOpenAiCompatibleBackend(this.environment.backend);
    try {
      const body = llama
        ? {
            model, messages: [{ role: "user", content: prompt.prompt }], stream: true,
            max_tokens: config.maxOutputTokens, temperature: config.temperature,
            stream_options: { include_usage: true },
          }
        : {
            model, prompt: prompt.prompt, stream: true, think: false, keep_alive: "30m",
            options: { num_predict: config.maxOutputTokens, temperature: config.temperature, ...(numCtx === undefined ? {} : { num_ctx: numCtx }) },
          };
      await this.ssh.requestStreamLines({
        host: this.environment.apiHost, port: this.environment.apiPort,
        path: llama ? "/v1/chat/completions" : "/api/generate",
        timeoutMs: getRequestTimeoutMs(targetInputTokens, concurrency, config.timeoutMs), signal, body,
      }, (value) => {
        const chunk = value as OllamaGenerateDone;
        lastChunk = chunk;
        if (!streamError && typeof chunk.error === "string" && chunk.error) streamError = chunk.error;
        if (isTokenChunk(chunk)) { streamedTokenCount += 1; const at = this.now(); if (firstTokenAt === undefined) firstTokenAt = at; lastTokenAt = at; }
        if (isCompletionChunk(chunk)) done = chunk;
      });
      if (streamError) throw new Error(`${llama ? "llama.cpp" : "Ollama"} API error: ${streamError}`);
      done ??= lastChunk;
      if (!done) throw new Error(`${llama ? "llama.cpp" : "Ollama"} did not return a completion chunk`);
      if (firstTokenAt === undefined) throw new Error(`${llama ? "llama.cpp" : "Ollama"} did not return a streamed token chunk`);

      const completedAt = this.now();
      const elapsedMs = completedAt - requestStarted;
      const evalCount = done.eval_count ?? done.usage?.completion_tokens ?? done.timings?.predicted_n ?? streamedTokenCount;
      return {
        model, targetInputTokens,
        actualInputTokens: done.prompt_eval_count ?? done.usage?.prompt_tokens ?? done.timings?.prompt_n,
        concurrency, round, workerIndex,
        ttftMs: firstTokenAt - requestStarted,
        serverPrefillMs: nanosToMs(done.prompt_eval_duration) ?? done.timings?.prompt_ms,
        decodeTokensPerSecond: decodeRate(done, streamedTokenCount) ?? measureClientDecodeRate({ generatedTokens: evalCount, firstTokenAt, lastTokenAt, completedAt }),
        generatedTokens: evalCount,
        loadMs: nanosToMs(done.load_duration),
        totalMs: nanosToMs(done.total_duration) ?? elapsedMs,
        status: "success",
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { model, targetInputTokens, concurrency, round, workerIndex, status: signal?.aborted ? "cancelled" : errorMessage.includes("timed out") ? "timeout" : "error", errorMessage };
    }
  }
}
