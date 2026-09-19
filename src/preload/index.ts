import { contextBridge, ipcRenderer } from "electron";
import type { AdvancedProgress, BenchmarkApi, BenchmarkProgress, CapabilityProgress, ReportFormat } from "../shared/ipc";
import type { BenchmarkConfig, BenchmarkSample, CapabilityConfig, CapabilityRunResult, SshConfig } from "../shared/types";
import type { AdvancedRunConfig, AdvancedRunResult } from "../shared/AdvancedScenarios";

const api: BenchmarkApi = {
  connect: (config: SshConfig) => ipcRenderer.invoke("connection:connect", config),
  useEndpoint: (endpointId: string) => ipcRenderer.invoke("connection:use-endpoint", endpointId),
  disconnect: () => ipcRenderer.invoke("connection:disconnect"),
  runBenchmark: (config: BenchmarkConfig, previousSamples?: BenchmarkSample[]) => ipcRenderer.invoke("benchmark:run", config, previousSamples),
  cancelBenchmark: () => ipcRenderer.invoke("benchmark:cancel"),
  onBenchmarkProgress: (listener: (progress: BenchmarkProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: BenchmarkProgress) => listener(progress);
    ipcRenderer.on("benchmark:progress", handler);
    return () => ipcRenderer.removeListener("benchmark:progress", handler);
  },
  exportReports: (request: { result: unknown; formats: ReportFormat[] }) => ipcRenderer.invoke("report:export", request),
  runCapability: (config: CapabilityConfig) => ipcRenderer.invoke('capability:run', config),
  cancelCapability: () => ipcRenderer.invoke('capability:cancel'),
  onCapabilityProgress: (listener: (progress: CapabilityProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: CapabilityProgress) => listener(progress);
    ipcRenderer.on('capability:progress', handler);
    return () => ipcRenderer.removeListener('capability:progress', handler);
  },
  exportCapabilityReports: (request: { result: CapabilityRunResult; formats: ReportFormat[] }) => ipcRenderer.invoke('capability-report:export', request),
  runAdvanced: (config: AdvancedRunConfig) => ipcRenderer.invoke("advanced:run", config),
  cancelAdvanced: () => ipcRenderer.invoke("advanced:cancel"),
  onAdvancedProgress: (listener: (progress: AdvancedProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: AdvancedProgress) => listener(progress);
    ipcRenderer.on("advanced:progress", handler);
    return () => ipcRenderer.removeListener("advanced:progress", handler);
  },
  exportAdvancedReports: (request: { result: AdvancedRunResult; formats: ReportFormat[] }) => ipcRenderer.invoke("advanced-report:export", request),
};

contextBridge.exposeInMainWorld("ollamaBenchmark", api);
