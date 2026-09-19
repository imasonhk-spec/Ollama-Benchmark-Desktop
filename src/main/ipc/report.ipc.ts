import { BrowserWindow, dialog, ipcMain } from "electron";
import type { BenchmarkRunResult } from "../benchmark/BenchmarkRunner";
import { getEnvironment } from "./connection.ipc";
import { exportPdfReport, exportReports, type ReportFormat } from "../reports/ReportExporter";

type ExportRequest = {
  result: BenchmarkRunResult;
  formats: ReportFormat[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForReportRender(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(`
    (async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })();
  `, true);
}

async function renderPdfAttempt(html: string): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await waitForReportRender(window);
    return await window.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      preferCSSPageSize: true,
    });
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

export async function renderPdf(html: string): Promise<Buffer> {
  try {
    return await renderPdfAttempt(html);
  } catch (firstError) {
    try {
      return await renderPdfAttempt(html);
    } catch (secondError) {
      throw new Error(`PDF 生成失败（已自动重试）：${errorMessage(secondError)}；首次错误：${errorMessage(firstError)}`);
    }
  }
}

export function registerReportIpc(): void {
  ipcMain.handle("report:export", async (_event, request: ExportRequest) => {
    const environment = getEnvironment();
    if (!environment) throw new Error("没有可用的服务器环境信息");
    const selected = await dialog.showOpenDialog({
      title: "选择报告输出目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selected.canceled || !selected.filePaths[0]) return [];

    const input = { environment, result: request.result };
    const formats = request.formats.filter((format) => format !== "pdf");
    const paths = await exportReports(input, formats, selected.filePaths[0]);
    if (request.formats.includes("pdf")) paths.push(await exportPdfReport(input, selected.filePaths[0], renderPdf));
    return paths;
  });
}
