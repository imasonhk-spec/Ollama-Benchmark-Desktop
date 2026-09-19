import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { capabilityConfigSchema } from '../../shared/schemas';
import { collectCapabilityDimensions } from '../../shared/CapabilityDimensions';
import { isOpenAiCompatibleBackend, type CapabilityConfig, type CapabilityDimension, type CapabilityDimensionMeta, type CapabilityModelSummary, type CapabilityQuestionResult, type CapabilityRunResult, type OllamaEnvironment, type OllamaGenerateDone } from '../../shared/types';
import { SshSession } from '../ssh/SshSession';
import { CAPABILITY_SUITE_VERSION, getCapabilityQuestions, type CapabilityQuestion } from './QuestionBank';
import { parseCapabilityAnswer, scoreCapabilityAnswer } from './CapabilityScorer';

export type CapabilityProgress = { completed: number; total: number; model: string; dimension: CapabilityDimension; questionId: string; question?: CapabilityQuestionResult };

function cloneEnvironment(environment: OllamaEnvironment): OllamaEnvironment { return { ...environment, gpuModels: [...environment.gpuModels], installedModels: [...environment.installedModels], warnings: [...environment.warnings], systemInfo: environment.systemInfo ? { ...environment.systemInfo } : undefined }; }
function decodeRate(response: OllamaGenerateDone): number | undefined {
  const count = response.eval_count ?? response.usage?.completion_tokens ?? response.timings?.predicted_n;
  const durationNs = response.eval_duration ?? (response.timings?.predicted_ms !== undefined ? response.timings.predicted_ms * 1_000_000 : undefined);
  return count && durationNs && durationNs > 0 ? count / (durationNs / 1_000_000_000) : undefined;
}
function openAiAnswer(response: OllamaGenerateDone): string { const choice = response.choices?.[0]; return choice?.message?.content ?? choice?.message?.reasoning_content ?? choice?.text ?? ''; }
function openAiThinking(response: OllamaGenerateDone): string | undefined { return response.choices?.[0]?.message?.reasoning_content ?? response.choices?.[0]?.delta?.reasoning_content; }
function isAbortError(error: unknown): boolean { return error instanceof Error && /cancel|abort/i.test(error.message); }

export class CapabilityRunner {
  public constructor(private readonly ssh: SshSession, private readonly environment: OllamaEnvironment, private readonly now: () => number = () => performance.now()) {}

  public async run(rawConfig: CapabilityConfig, onProgress?: (progress: CapabilityProgress) => void, signal?: AbortSignal): Promise<CapabilityRunResult> {
    const config = capabilityConfigSchema.parse(rawConfig);
    const questions = config.questions?.length ? config.questions : getCapabilityQuestions();
    const startedAt = new Date().toISOString();
    const results: CapabilityQuestionResult[] = [];
    const total = config.models.length * questions.length;
    let completed = 0;
    let cancelled = false;
    for (const model of config.models) {
      for (const question of questions) {
        if (signal?.aborted) { cancelled = true; break; }
        const questionResult = await this.runQuestion(model, question, config, signal);
        results.push(questionResult); completed += 1;
        onProgress?.({ completed, total, model, dimension: question.dimension, questionId: question.id, question: questionResult });
        if (questionResult.status === 'cancelled') { cancelled = true; break; }
      }
      if (cancelled) break;
    }
    if (completed < total) cancelled = true;
    const dimensions = collectCapabilityDimensions(questions);
    return { startedAt, finishedAt: new Date().toISOString(), cancelled, config, suiteVersion: config.suiteVersion || CAPABILITY_SUITE_VERSION, environment: cloneEnvironment(this.environment), questions: results, dimensions, summaries: this.summarize(config.models, questions, dimensions, results) };
  }

  private async runQuestion(model: string, question: CapabilityQuestion, config: CapabilityConfig, signal?: AbortSignal): Promise<CapabilityQuestionResult> {
    const started = this.now();
    const requestId = randomUUID();
    const prompt = `${question.prompt}\n\n本次评测请求标识：${requestId}`;
    const llama = isOpenAiCompatibleBackend(this.environment.backend);
    const body: Record<string, unknown> = llama
      ? { model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: config.maxOutputTokens, temperature: config.temperature, seed: 2026 }
      : { model, prompt, stream: false, keep_alive: '30m', format: 'json', options: { num_predict: config.maxOutputTokens, temperature: config.temperature, seed: 2026 }, think: config.thinkingMode === 'on' };
    try {
      let response: OllamaGenerateDone;
      try {
        response = await this.ssh.requestJson<OllamaGenerateDone>({ host: this.environment.apiHost, port: this.environment.apiPort, path: llama ? '/v1/chat/completions' : '/api/generate', timeoutMs: config.timeoutMs, signal, body });
      } catch (firstError) {
        if (llama || signal?.aborted || !/format|think|unsupported|unknown field/i.test(String(firstError))) throw firstError;
        const retryBody = { ...body }; delete retryBody.format; delete retryBody.think;
        response = await this.ssh.requestJson<OllamaGenerateDone>({ host: this.environment.apiHost, port: this.environment.apiPort, path: '/api/generate', timeoutMs: config.timeoutMs, signal, body: retryBody });
      }
      const rawResponse = llama ? openAiAnswer(response) : response.response ?? response.message?.content ?? '';
      const thinking = llama ? openAiThinking(response) : response.thinking ?? response.message?.thinking;
      const parsed = parseCapabilityAnswer(rawResponse, question.responseKey);
      const scored = parsed.parserMode === 'invalid'
        ? { score: 0, evidence: ['未解析到模型答案'] }
        : scoreCapabilityAnswer(question, parsed.answer, { rawResponse, root: parsed.root, value: parsed.value });
      if (thinking) scored.evidence.push('检测到思考内容（不计入答案）');
      return { model, id: question.id, dimension: question.dimension, title: question.title, prompt, response: rawResponse, score: scored.score, maxScore: question.maxScore, status: parsed.parserMode === 'invalid' ? 'error' : 'success', elapsedMs: this.now() - started, generatedTokens: response.eval_count ?? response.usage?.completion_tokens ?? response.timings?.predicted_n, decodeTokensPerSecond: decodeRate(response), parserMode: parsed.parserMode, reasoningDetected: Boolean(thinking), evidence: scored.evidence };
    } catch (error) {
      return { model, id: question.id, dimension: question.dimension, title: question.title, prompt, response: '', score: 0, maxScore: question.maxScore, status: signal?.aborted || isAbortError(error) ? 'cancelled' : 'error', elapsedMs: this.now() - started, parserMode: 'invalid', reasoningDetected: false, evidence: [], errorMessage: error instanceof Error ? error.message : String(error) };
    }
  }

  private summarize(models: string[], questions: CapabilityQuestion[], dimensions: CapabilityDimensionMeta[], results: CapabilityQuestionResult[]): CapabilityModelSummary[] {
    const summaries = models.map((model) => {
      const modelResults = results.filter((result) => result.model === model);
      // 维度由题库决定：题库里有哪些维度，就按哪些维度聚合，不再依赖内置 7 个。
      const dimensionMaxScores = Object.fromEntries(dimensions.map((dimension) => [dimension.key, dimension.maxScore]));
      const dimensionScores = Object.fromEntries(dimensions.map((dimension) => [dimension.key, modelResults.filter((result) => result.dimension === dimension.key).reduce((sum, result) => sum + result.score, 0)]));
      const timings = modelResults.map((result) => result.elapsedMs).filter((value): value is number => value !== undefined);
      const rates = modelResults.map((result) => result.decodeTokensPerSecond).filter((value): value is number => value !== undefined);
      return { model, rank: 0, totalScore: Object.values(dimensionScores).reduce((sum, value) => sum + value, 0), maxScore: questions.reduce((sum, question) => sum + question.maxScore, 0), dimensionScores, dimensionMaxScores, completedCount: modelResults.length, questionCount: questions.length, averageResponseMs: timings.length ? timings.reduce((sum, value) => sum + value, 0) / timings.length : undefined, averageDecodeTokensPerSecond: rates.length ? rates.reduce((sum, value) => sum + value, 0) / rates.length : undefined } satisfies CapabilityModelSummary;
    });
    return summaries.sort((left, right) => right.totalScore - left.totalScore || right.completedCount - left.completedCount || left.model.localeCompare(right.model)).map((summary, index) => ({ ...summary, rank: index + 1 }));
  }
}