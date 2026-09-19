import { describe, expect, it } from "vitest";
import { runAdvanced } from "./AdvancedRunner";
import type { StreamingTransport } from "./ScenarioClient";
import { createDefaultAdvancedConfig, type AdvancedRunConfig } from "../../shared/AdvancedScenarios";
import type { OllamaEnvironment } from "../../shared/types";

const environment: OllamaEnvironment = {
  backend: "ollama",
  deployment: "native",
  binary: "ollama",
  apiHost: "127.0.0.1",
  apiPort: 11_434,
  version: "0.1.0",
  gpuVendor: "none",
  gpuModels: [],
  installedModels: ["test-model"],
  warnings: [],
};

/**
 * In-memory transport that emits a small Ollama-style token stream and advances
 * a shared clock so ScenarioClient records meaningful TTFT/E2E timestamps.
 */
function makeFakeTransport(clock: { t: number }) {
  const tokensPerRequest = 6;
  return {
    async requestStreamLines(_request: unknown, onLine: (value: unknown) => void): Promise<void> {
      clock.t += 120; // simulated TTFT
      for (let index = 0; index < tokensPerRequest; index += 1) {
        onLine({ response: "tok" });
        clock.t += 12;
      }
      clock.t += 4;
      onLine({ done: true, eval_count: tokensPerRequest, prompt_eval_count: 40 });
    },
  } satisfies StreamingTransport;
}

function makeConfig(): AdvancedRunConfig {
  const config = createDefaultAdvancedConfig("test-model");
  return {
    ...config,
    scenarios: ["latency", "concurrency", "fairness"],
    latency: { combos: [{ inputTokens: 128, outputTokens: 32 }], repeat: 2, warmup: 0 },
    concurrency: {
      ...config.concurrency,
      levels: [1, 2],
      requestsPerLevel: 1,
      probeDurationMs: 1,
      steadyDurationMs: 1,
      warmup: 0,
      autotune: false,
      maxConcurrency: 8,
    },
  };
}

describe("runAdvanced orchestrator", () => {
  it("runs the selected scenarios and assembles one result", async () => {
    const clock = { t: 0 };
    const transport = makeFakeTransport(clock);
    const result = await runAdvanced({
      transport,
      environment,
      config: makeConfig(),
      now: () => clock.t,
    });

    expect(result.planVersion).toBe("llm-bench-2026.08");
    expect(result.cancelled).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.latency?.combos.length).toBeGreaterThan(0);
    expect(result.concurrency?.levels.length).toBeGreaterThan(0);
    expect(result.concurrency?.recommendedConcurrency).toBeGreaterThan(0);
    expect(result.fairness?.stats.length).toBeGreaterThan(0);
    expect(result.degradation).toBeDefined();
    expect(result.degradation!.sampleCount).toBeGreaterThan(0);
  });

  it("isolates a scenario crash into the errors list without throwing", async () => {
    const clock = { t: 0 };
    const broken: StreamingTransport = {
      async requestStreamLines(_request, onLine) {
        onLine({ error: "maximum context length exceeded" });
      },
    };
    const config = createDefaultAdvancedConfig("test-model");
    config.scenarios = ["max-context"];
    config.maxContext = { ...config.maxContext, levels: [1_024, 2_048] };
    const result = await runAdvanced({
      transport: broken,
      environment,
      config,
      now: () => clock.t,
    });
    expect(result.maxContext?.points.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });
});
