import { dialog, ipcMain } from 'electron';
import type { AdvancedRunResult } from '../../shared/AdvancedScenarios';
import type { ReportFormat } from '../../shared/types';
import { exportAdvancedReports } from '../reports/AdvancedReportExporter';
import { renderPdf } from './report.ipc';

type AdvancedExportRequest = { result: AdvancedRunResult; formats: ReportFormat[] };

export function registerAdvancedReportIpc(): void {
  ipcMain.handle('advanced-report:export', async (_event, request: AdvancedExportRequest) => {
    const selected = await dialog.showOpenDialog({ title: '选择高级评测报告输出目录', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return [];
    return exportAdvancedReports({ result: request.result }, request.formats, selected.filePaths[0], renderPdf);
  });
}
