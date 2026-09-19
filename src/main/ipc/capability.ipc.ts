import { ipcMain } from 'electron';
import { capabilityConfigSchema } from '../../shared/schemas';
import type { CapabilityConfig } from '../../shared/types';
import { CapabilityRunner, type CapabilityProgress } from '../capability/CapabilityRunner';
import { getEnvironment, getSshSession } from './connection.ipc';

let activeAbortController: AbortController | undefined;

export function registerCapabilityIpc(): void {
  ipcMain.handle('capability:run', async (event, rawConfig: CapabilityConfig) => {
    const config = capabilityConfigSchema.parse(rawConfig);
    const environment = getEnvironment();
    if (!environment || environment.deployment === 'not-found') throw new Error('请先连接并确认 Ollama 或 llama.cpp API 可用');
    if (activeAbortController) throw new Error('已有能力评测正在运行');
    activeAbortController = new AbortController();
    try {
      const progress = (value: CapabilityProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send('capability:progress', value);
      };
      return await new CapabilityRunner(getSshSession(), environment).run(config, progress, activeAbortController.signal);
    } finally {
      activeAbortController = undefined;
    }
  });
  ipcMain.handle('capability:cancel', () => { activeAbortController?.abort(); });
}
