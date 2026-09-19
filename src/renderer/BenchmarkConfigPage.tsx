import { useEffect, useMemo, useState } from "react";
import { DEFAULT_CONCURRENCIES, DEFAULT_INPUT_LENGTHS, defaultModelsForBackend, type BenchmarkConfig, type InferenceBackend } from "../shared/types";

export type BenchmarkConfigPageProps = {
  installedModels?: string[];
  backend?: InferenceBackend;
  initialConfig?: BenchmarkConfig;
  onStart: (config: BenchmarkConfig) => void;
  onConfigChange?: (config: BenchmarkConfig) => void;
  onCancel?: () => void;
};

export function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function addNumber(value: string, current: number[]): number[] {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return current;
  return [...new Set([...current, parsed])].sort((a, b) => a - b);
}

function addToSelection(value: string, setSelected: (next: (current: number[]) => number[]) => void): void {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return;
  setSelected((current) => current.includes(parsed) ? current : [...current, parsed].sort((a, b) => a - b));
}

export function BenchmarkConfigPage({ installedModels = [], backend, initialConfig, onStart, onConfigChange, onCancel }: BenchmarkConfigPageProps): React.JSX.Element {
  const defaultModels = defaultModelsForBackend(backend);
  const [customModels, setCustomModels] = useState<string[]>(() => (initialConfig?.models ?? []).filter((model) => !defaultModels.includes(model as never) && !installedModels.includes(model)));
  const availableModels = useMemo(
    () => [...new Set([...defaultModels, ...installedModels, ...customModels])],
    [customModels, installedModels, defaultModels],
  );
  const [models, setModels] = useState<string[]>(initialConfig?.models ?? [defaultModels[0]]);
  const [inputLengthOptions, setInputLengthOptions] = useState<number[]>(() => [...new Set([...DEFAULT_INPUT_LENGTHS, ...(initialConfig?.inputLengths ?? [])])].sort((a, b) => a - b));
  const [inputLengths, setInputLengths] = useState<number[]>(initialConfig?.inputLengths ?? [...DEFAULT_INPUT_LENGTHS]);
  const [concurrencyOptions, setConcurrencyOptions] = useState<number[]>(() => [...new Set([...DEFAULT_CONCURRENCIES, ...(initialConfig?.concurrencies ?? [])])].sort((a, b) => a - b));
  const [concurrencies, setConcurrencies] = useState<number[]>(initialConfig?.concurrencies ?? [...DEFAULT_CONCURRENCIES]);
  const [rounds, setRounds] = useState(initialConfig?.rounds ?? 5);
  const [maxOutputTokens, setMaxOutputTokens] = useState(initialConfig?.maxOutputTokens ?? 50);
  const [customModel, setCustomModel] = useState("");
  const [customLength, setCustomLength] = useState("");
  const [customConcurrency, setCustomConcurrency] = useState("");

  const addCustomModel = () => {
    const value = customModel.trim();
    if (value) {
      setCustomModels((current) => current.includes(value) ? current : [...current, value]);
      setModels((current) => current.includes(value) ? current : [...current, value]);
    }
    setCustomModel("");
  };

  const addInputLength = () => {
    setInputLengthOptions((current) => addNumber(customLength, current));
    addToSelection(customLength, setInputLengths);
    setCustomLength("");
  };

  const addConcurrency = () => {
    setConcurrencyOptions((current) => addNumber(customConcurrency, current));
    addToSelection(customConcurrency, setConcurrencies);
    setCustomConcurrency("");
  };

  const config: BenchmarkConfig = {
    models,
    inputLengths,
    concurrencies,
    rounds,
    maxOutputTokens,
    temperature: initialConfig?.temperature ?? 0,
    warmupEnabled: initialConfig?.warmupEnabled ?? true,
    timeoutMs: initialConfig?.timeoutMs ?? 600_000,
    contextWindow: initialConfig?.contextWindow ?? "auto-fixed",
  };
  useEffect(() => { onConfigChange?.(config); }, [models, inputLengths, concurrencies, rounds, maxOutputTokens, onConfigChange]);
  const requestCount = models.length * inputLengths.length * concurrencies.reduce((sum, value) => sum + value * rounds, 0);
  const highLoadWarning = inputLengths.some((value) => value >= 32_000) && concurrencies.some((value) => value >= 4);

  return (
    <section className="card config-page">
      <div className="config-heading">
        <div><p className="eyebrow">TEST PLAN</p><h2>配置性能测试</h2></div>
        <p className="muted">每个输入长度和并发组合独立执行，默认每组 5 轮。</p>
      </div>
      <fieldset>
        <legend>测试模型</legend>
        <div className="chips">{availableModels.map((model) => <button type="button" className={`chip ${models.includes(model) ? "selected" : ""}`} key={model} onClick={() => setModels(toggleValue(models, model))}>{model}</button>)}</div>
        <div className="inline-add"><input value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="添加自定义模型，例如 llama3:8b" /><button type="button" className="secondary" onClick={addCustomModel}>添加</button></div>
      </fieldset>
      <fieldset>
        <legend>输入长度（tokens）</legend>
        <div className="chips">{inputLengthOptions.map((length) => <button type="button" className={`chip ${inputLengths.includes(length) ? "selected" : ""}`} key={length} onClick={() => setInputLengths(toggleValue(inputLengths, length))}>{length.toLocaleString()}</button>)}</div>
        <div className="inline-add"><input value={customLength} onChange={(event) => setCustomLength(event.target.value)} placeholder="自定义长度" inputMode="numeric" /><button type="button" className="secondary" onClick={addInputLength}>添加</button></div>
      </fieldset>
      <fieldset>
        <legend>并发数</legend>
        <div className="chips">{concurrencyOptions.map((value) => <button type="button" className={`chip ${concurrencies.includes(value) ? "selected" : ""}`} key={value} onClick={() => setConcurrencies(toggleValue(concurrencies, value))}>{value}</button>)}</div>
        <div className="inline-add"><input value={customConcurrency} onChange={(event) => setCustomConcurrency(event.target.value)} placeholder="自定义并发数" inputMode="numeric" /><button type="button" className="secondary" onClick={addConcurrency}>添加</button></div>
      </fieldset>
      <div className="row config-numbers"><label>测试轮次<input type="number" min="1" max="100" value={rounds} onChange={(event) => setRounds(Number(event.target.value))} /></label><label>最大输出 tokens<input type="number" min="1" max="4096" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(Number(event.target.value))} /></label></div>
      {highLoadWarning && <p className="warning">提示：32K 以上输入长度与 4 以上并发会显著增加显存、内存和排队时间；建议先用并发 1/2 验证，再逐步提高并发。</p>}
      <div className="config-summary">预计独立请求数：<strong>{requestCount.toLocaleString()}</strong></div>
      <div className="actions"><button type="button" disabled={!models.length || !inputLengths.length || !concurrencies.length} onClick={() => onStart(config)}>开始测试</button>{onCancel && <button type="button" className="secondary" onClick={onCancel}>返回</button>}</div>
    </section>
  );
}
