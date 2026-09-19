const FILLER_SENTENCE = "这是一段用于模型预填充性能测试的稳定文本。";

export type BenchmarkPrompt = {
  prompt: string;
  nonce: string;
  targetInputTokens: number;
};

/**
 * Builds a deterministic prompt with a unique prefix. Ollama returns the
 * actual prompt_eval_count, so the caller must use that value in reports.
 * Exact tokenizer calibration is deliberately kept outside this pure module.
 */
export function createBenchmarkPrompt(targetInputTokens: number, nonce: string): BenchmarkPrompt {
  const safeTarget = Math.max(1, Math.floor(targetInputTokens));
  // This text averages roughly two Chinese characters per token. The final
  // prompt_eval_count is authoritative and is recorded by BenchmarkRunner.
  const repeatCount = Math.max(1, Math.ceil(safeTarget / 12));
  const body = Array.from({ length: repeatCount }, () => FILLER_SENTENCE).join(" ");
  return {
    nonce,
    targetInputTokens: safeTarget,
    prompt: [
      `Ollama benchmark request nonce: ${nonce}`,
      "请生成简短回答。不要复述输入内容。",
      body,
    ].join("\n\n"),
  };
}
