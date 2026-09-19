import { ipcMain } from "electron";
import { benchmarkConfigSchema } from "../../shared/schemas";
import type { BenchmarkConfig, BenchmarkSample } from "../../shared/types";
import { BenchmarkRunner, type BenchmarkProgress } from "../benchmark/BenchmarkRunner";
import { getEnvironment, getSshSession } from "./connection.ipc";

let activeAbortController: AbortController | undefined;

export function registerBenchmarkIpc(): void {
  ipcMain.handle("benchmark:run", async (event, rawConfig: BenchmarkConfig, previousSamples?: BenchmarkSample[]) => {
    const config = benchmarkConfigSchema.parse(rawConfig);
    const environment = getEnvironment();
    if (!environment || environment.deployment === "not-found") {
      throw new Error("请先连接并确认 Ollama 或 llama.cpp API 可用");
    }
    if (activeAbortController) throw new Error("已有测试正在运行");

    activeAbortController = new AbortController();
    try {
      const progress = (value: BenchmarkProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send("benchmark:progress", value);
      };
      return await new BenchmarkRunner(getSshSession(), environment).run(config, progress, activeAbortController.signal, previousSamples ?? []);
    } finally {
      activeAbortController = undefined;
    }
  });

  ipcMain.handle("benchmark:cancel", () => {
    activeAbortController?.abort();
  });
}
