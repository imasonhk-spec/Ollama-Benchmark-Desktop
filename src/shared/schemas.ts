import { z } from "zod";
import { CAPABILITY_MAX_QUESTION_SCORE, CAPABILITY_RESPONSE_KEYS, type CapabilityJsonValue } from "./types";

/**
 * 接受 V2.5 的三个协议族，同时接受 V2.4 及更早的选项值（`ollama-rocm` /
 * `llama.cpp-rocm` / `llama.cpp-vulkan`），由 normalizeBackendPreference 归一，
 * 这样旧版本保存过的连接配置仍可直接使用。
 */
export const backendPreferenceSchema = z.enum([
  "ollama",
  "llama.cpp",
  "openai-compatible",
  "ollama-rocm",
  "llama.cpp-rocm",
  "llama.cpp-vulkan",
]);

export const sshConfigSchema = z.object({
  host: z.string().trim().min(1, "请输入服务器 IP 或主机名"),
  port: z.number().int().min(1).max(65_535),
  username: z.string().trim().min(1, "请输入用户名"),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  apiPort: z.number().int().min(1).max(65_535).optional(),
  apiHost: z.string().trim().min(1).max(255).optional(),
  apiKey: z.string().max(512).optional(),
  backendPreference: backendPreferenceSchema.optional(),
  connectTimeoutMs: z.number().int().min(1_000).max(120_000),
}).refine((value) => Boolean(value.password || value.privateKey), {
  message: "密码和私钥至少提供一种",
  path: ["password"],
});

export const benchmarkConfigSchema = z.object({
  models: z.array(z.string().trim().min(1)).min(1),
  inputLengths: z.array(z.number().int().positive()).min(1),
  concurrencies: z.array(z.number().int().positive()).min(1),
  rounds: z.number().int().min(1).max(100),
  maxOutputTokens: z.number().int().min(1).max(4_096),
  temperature: z.number().min(0).max(2),
  warmupEnabled: z.boolean(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  contextWindow: z.enum(["auto-fixed", "server-default"]),
});

export function uniqueSortedPositiveIntegers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

const stringListSchema = z.array(z.string().trim().min(1)).min(1);
const expectedMapSchema = z.record(z.string(), z.string());
// json_schema 期望值支持嵌套与 null（null = 该字段应当缺失）
const jsonValueSchema: z.ZodType<CapabilityJsonValue> = z.lazy(() => z.union([z.string(), z.null(), z.record(z.string(), jsonValueSchema)]));

const capabilityRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("keywords"), groups: z.array(z.array(z.string().trim().min(1)).min(1)).min(1), minimumLength: z.number().int().positive().optional(), maximumLength: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("number"), answers: stringListSchema, tolerance: z.number().nonnegative().optional() }),
  z.object({ kind: z.literal("exact"), aliases: stringListSchema }),
  z.object({ kind: z.literal("code"), checks: stringListSchema }),
  z.object({ kind: z.literal("contains_all"), terms: stringListSchema }),
  z.object({ kind: z.literal("formula"), checks: stringListSchema }),
  z.object({ kind: z.literal("sql_result"), checks: stringListSchema }),
  z.object({ kind: z.literal("json_schema"), required: stringListSchema.optional(), expected: z.union([jsonValueSchema, z.array(jsonValueSchema).min(1)]).optional(), expectedCount: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("tool_call"), expectedTools: stringListSchema.optional(), requiredArgs: stringListSchema.optional(), expected: expectedMapSchema.optional(), notContains: stringListSchema.optional() }),
]);

export const capabilityQuestionSchema = z.object({
  // 维度由题库决定，不再限定内置 7 个：导入的题库里出现什么 dimension，就用什么维度。
  id: z.string().trim().min(1), dimension: z.string().trim().min(1).max(64), dimensionLabel: z.string().trim().max(64).optional(),
  title: z.string().trim().min(1), prompt: z.string().trim().min(1), responseKey: z.enum(CAPABILITY_RESPONSE_KEYS), maxScore: z.number().positive().max(CAPABILITY_MAX_QUESTION_SCORE), rule: capabilityRuleSchema,
});

export const capabilityConfigSchema = z.object({
  models: z.array(z.string().trim().min(1)).min(1),
  maxOutputTokens: z.number().int().min(64).max(4_096),
  temperature: z.number().min(0).max(2),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  thinkingMode: z.enum(["off", "on"]),
  suiteVersion: z.string().trim().min(1),
  questions: z.array(capabilityQuestionSchema).max(500).optional(),
});

/* -------------------------------------------------------------------------- */
/* Advanced evaluation scenarios (ported from the llm-bench test plan)         */
/* -------------------------------------------------------------------------- */

const latencyComboSchema = z.object({
  inputTokens: z.number().int().positive().max(1_000_000),
  outputTokens: z.number().int().positive().max(8_192),
});

export const advancedRunConfigSchema = z.object({
  model: z.string().trim().min(1, "请选择要评测的模型"),
  scenarios: z
    .array(z.enum(["latency", "concurrency", "max-context", "stability", "fairness", "needle"]))
    .min(1, "至少选择一个测试场景"),
  latency: z.object({
    combos: z.array(latencyComboSchema).min(1).max(32),
    repeat: z.number().int().min(1).max(100),
    warmup: z.number().int().min(0).max(10),
  }),
  concurrency: z.object({
    levels: z.array(z.number().int().positive().max(4_096)).min(1).max(32),
    inputTokens: z.number().int().positive().max(1_000_000),
    outputTokens: z.number().int().positive().max(8_192),
    requestsPerLevel: z.number().int().min(1).max(2_048),
    probeDurationMs: z.number().int().min(1_000).max(3_600_000),
    steadyDurationMs: z.number().int().min(0).max(3_600_000),
    warmup: z.number().int().min(0).max(10),
    temperature: z.number().min(0).max(2),
    autotune: z.boolean(),
    maxConcurrency: z.number().int().min(1).max(4_096),
  }),
  maxContext: z.object({
    levels: z.array(z.number().int().positive().max(4_000_000)).min(1).max(32),
    maxOutputTokens: z.number().int().min(1).max(1_024),
    concurrency: z.number().int().min(1).max(64),
    requestTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  }),
  stability: z.object({
    concurrency: z.number().int().min(1).max(1_024),
    durationMinutes: z.number().min(0.1).max(600),
    inputTokens: z.number().int().positive().max(1_000_000),
    outputTokens: z.number().int().positive().max(8_192),
    bucketSeconds: z.number().int().min(5).max(3_600),
    temperature: z.number().min(0).max(2),
  }),
  needle: z.object({
    lengths: z.array(z.number().int().positive().max(1_000_000)).min(1).max(16),
    repeats: z.number().int().min(1).max(20),
    maxOutputTokens: z.number().int().min(8).max(1_024),
    depthPercents: z.array(z.number().min(0).max(100)).min(1).max(10),
  }),
  requestTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  seed: z.number().int().min(0).max(2_147_483_647),
});