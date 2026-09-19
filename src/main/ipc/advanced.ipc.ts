import { ipcMain } from "electron";
import { advancedRunConfigSchema } from "../../shared/schemas";
import type { AdvancedRunConfig } from "../../shared/AdvancedScenarios";
import { runAdvanced } from "../advanced/AdvancedRunner";
import type { AdvancedProgress } from "../../shared/ipc";
import { getEnvironment, getSshSession } from "./connection.ipc";

let activeAbortController: AbortController | undefined;

export function registerAdvancedIpc(): void {
  ipcMain.handle("advanced:run", async (event, rawConfig: AdvancedRunConfig) => {
    const config = advancedRunConfigSchema.parse(rawConfig);
    const environment = getEnvironment();
    if (!environment || environment.deployment === "not-found") {
      throw new Error("请先连接并确认 Ollama 或 llama.cpp API 可用");
    }
    if (activeAbortController) throw new Error("已有高级评测正在运行");

    activeAbortController = new AbortController();
    try {
      const onProgress = (value: AdvancedProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send("advanced:progress", value);
      };
      return await runAdvanced({
        transport: getSshSession(),
        environment,
        config,
        signal: activeAbortController.signal,
        onProgress,
      });
    } finally {
      activeAbortController = undefined;
    }
  });

  ipcMain.handle("advanced:cancel", () => {
    activeAbortController?.abort();
  });
}
