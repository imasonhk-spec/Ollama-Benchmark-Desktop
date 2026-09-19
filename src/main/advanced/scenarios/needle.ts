/**
 * Needle in a Haystack — long-context recall (plan `llm_bench/scenarios/needle.py`).
 *
 * Benchmarks score knowledge; they do not answer "can the model still find a
 * fact buried in 64K tokens". A key fact is planted at a given depth of a filler
 * document, the model is asked about it, and recall is reported per length tier.
 */

import type {
  AdvancedRunConfig,
  NeedleLengthRecall,
  NeedlePoint,
  NeedleScenarioResult,
} from "../../../shared/AdvancedScenarios";
import { NEEDLES, buildHaystack, checkNeedleAnswer } from "../AdvancedFiller";
import type { ScenarioClient } from "../ScenarioClient";

export type NeedleScenarioDeps = {
  client: ScenarioClient;
  config: AdvancedRunConfig;
  signal?: AbortSignal;
  onPoint?: (point: NeedlePoint) => void;
};

export function summarizeRecall(points: NeedlePoint[]): { recallByLength: NeedleLengthRecall[]; overallRecall: number } {
  const lengths = [...new Set(points.map((point) => point.lengthTokens))].sort((a, b) => a - b);
  const recallByLength = lengths.map((lengthTokens) => {
    const group = points.filter((point) => point.lengthTokens === lengthTokens);
    const correct = group.filter((point) => point.correct).length;
    return { lengthTokens, correct, total: group.length, recall: group.length ? correct / group.length : 0 };
  });
  const correct = points.filter((point) => point.correct).length;
  return { recallByLength, overallRecall: points.length ? correct / points.length : 0 };
}

export async function runNeedleScenario(deps: NeedleScenarioDeps): Promise<NeedleScenarioResult> {
  const { client, config, signal } = deps;
  const settings = config.needle;
  const points: NeedlePoint[] = [];

  for (const lengthTokens of [...settings.lengths].sort((a, b) => a - b)) {
    for (const [needleIndex, needle] of NEEDLES.entries()) {
      for (const depthPercent of settings.depthPercents) {
        for (let repeat = 0; repeat < settings.repeats; repeat += 1) {
          if (signal?.aborted) break;
          const haystack = buildHaystack(lengthTokens, needle.fact, depthPercent);
          const prompt = `${haystack}\n\n${needle.question}\n请简短回答。`;
          const outcome = await client.execute({
            model: config.model,
            prompt,
            maxOutputTokens: settings.maxOutputTokens,
            temperature: 0,
            timeoutMs: config.requestTimeoutMs,
            numCtx: lengthTokens + settings.maxOutputTokens + 1_024,
            signal,
          });
          const answer = outcome.responseText.trim();
          const point: NeedlePoint = {
            lengthTokens,
            needleIndex,
            depthPercent,
            answered: outcome.ok && answer.length > 0,
            correct: outcome.ok && checkNeedleAnswer(answer, needleIndex),
            answer: answer.slice(0, 400),
            e2eMs: outcome.e2eMs,
            errorMessage: outcome.errorMessage,
          };
          points.push(point);
          deps.onPoint?.(point);
        }
      }
    }
  }

  return { points, ...summarizeRecall(points) };
}
