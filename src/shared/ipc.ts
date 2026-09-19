import type { BenchmarkConfig, BenchmarkSample, CapabilityConfig, CapabilityRunResult, OllamaEnvironment, ReportFormat, SshConfig } from "./types";
import type { AdvancedRunConfig, AdvancedRunResult, AdvancedScenario } from "./AdvancedScenarios";

export type AdvancedProgress = {
  scenario: AdvancedScenario;
  label: string;
  stage: "start" | "progress" | "done";
  message?: string;
  /** 1-based position of this scenario within the active plan. */
  index?: number;
  /** Total scenario count in the active plan. */
  total?: number;
  /** Optional incremental counters for a progress bar. */
  current?: number;
  totalUnits?: number;
};

export type BenchmarkProgress = {
  completed: number;
  total: number;
  model: string;
  inputLength: number;
  concurrency: number;
  round: number;
  sample?: BenchmarkSample;
};

export type { ReportFormat } from "./types";

export type BenchmarkApi = {
  connect: (config: SshConfig) => Promise<OllamaEnvironment>;
  /** 在多端点场景下手动切换评测对象（探测结果里已带模型清单，无需重新探测）。 */
  useEndpoint: (endpointId: string) => Promise<OllamaEnvironment>;
  disconnect: () => Promise<void>;
  runBenchmark: (config: BenchmarkConfig, previousSamples?: BenchmarkSample[]) => Promise<unknown>;
  cancelBenchmark: () => Promise<void>;
  onBenchmarkProgress: (listener: (progress: BenchmarkProgress) => void) => () => void;
  exportReports: (request: { result: unknown; formats: ReportFormat[] }) => Promise<string[]>;
  runCapability: (config: CapabilityConfig) => Promise<CapabilityRunResult>;
  cancelCapability: () => Promise<void>;
  onCapabilityProgress: (listener: (progress: CapabilityProgress) => void) => () => void;
  exportCapabilityReports: (request: { result: CapabilityRunResult; formats: ReportFormat[] }) => Promise<string[]>;
  runAdvanced: (config: AdvancedRunConfig) => Promise<AdvancedRunResult>;
  cancelAdvanced: () => Promise<void>;
  onAdvancedProgress: (listener: (progress: AdvancedProgress) => void) => () => void;
  exportAdvancedReports: (request: { result: AdvancedRunResult; formats: ReportFormat[] }) => Promise<string[]>;
};

export type CapabilityProgress = {
  completed: number;
  total: number;
  model: string;
  dimension: string;
  questionId: string;
  question?: CapabilityRunResult['questions'][number];
};
