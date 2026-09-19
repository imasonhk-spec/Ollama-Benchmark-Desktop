import { dialog, ipcMain } from 'electron';
import type { CapabilityRunResult, ReportFormat } from '../../shared/types';
import { exportCapabilityReports } from '../reports/CapabilityReportExporter';
import { renderPdf } from './report.ipc';

type CapabilityExportRequest = { result: CapabilityRunResult; formats: ReportFormat[] };

export function registerCapabilityReportIpc(): void {
  ipcMain.handle('capability-report:export', async (_event, request: CapabilityExportRequest) => {
    const selected = await dialog.showOpenDialog({ title: '选择能力报告输出目录', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return [];
    return exportCapabilityReports({ result: request.result }, request.formats, selected.filePaths[0], renderPdf);
  });
}
