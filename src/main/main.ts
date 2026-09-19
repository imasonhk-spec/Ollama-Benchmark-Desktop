import { app, BrowserWindow, Menu } from "electron";
import { join } from "node:path";
import { registerBenchmarkIpc } from "./ipc/benchmark.ipc";
import { registerCapabilityIpc } from "./ipc/capability.ipc";
import { registerCapabilityReportIpc } from "./ipc/capability-report.ipc";
import { registerConnectionIpc } from "./ipc/connection.ipc";
import { registerReportIpc } from "./ipc/report.ipc";
import { registerAdvancedIpc } from "./ipc/advanced.ipc";
import { registerAdvancedReportIpc } from "./ipc/advanced-report.ipc";

let windowRef: BrowserWindow | undefined;

function createWindow(): void {
  windowRef = new BrowserWindow({
    title: "Ollama Benchmark_V2.5-明松Mason",
    width: 1_280,
    height: 860,
    minWidth: 1_000,
    minHeight: 700,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload imports Electron's contextBridge/ipcRenderer. Keep the
      // preload unsandboxed while retaining renderer isolation.
      sandbox: false,
    },
  });

  windowRef.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[preload-error] ${preloadPath}: ${error.message}`);
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) void windowRef.loadURL(devServerUrl);
  else void windowRef.loadFile(join(__dirname, "../renderer/index.html"));
  windowRef.on("closed", () => { windowRef = undefined; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerConnectionIpc();
  registerBenchmarkIpc();
  registerCapabilityIpc();
  registerCapabilityReportIpc();
  registerReportIpc();
  registerAdvancedIpc();
  registerAdvancedReportIpc();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
