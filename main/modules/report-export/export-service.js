'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateStamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function formatTimeStamp(d = new Date()) {
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function buildFileName(fileNameBase, overwriteMode, at = new Date()) {
  const base = String(fileNameBase || 'report').replace(/\.csv$/i, '');
  const day = formatDateStamp(at);
  if (overwriteMode === 'AppendTimestamp') {
    return `${base}_${day}_${formatTimeStamp(at)}.csv`;
  }
  return `${base}_${day}.csv`;
}

function createExportService({
  repo,
  sqlRunner,
  csvWriter,
  outputFactory,
  app,
  fs,
  path,
  computeNextRunAt,
  newId,
  nowIso
}) {
  const running = new Set();

  function tempDir() {
    const dir = path.join(app.getPath('userData'), 'report-export-temp');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function safeUnlink(file) {
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {}
  }

  function assertDestinationReady(report, executionType) {
    if (report.outputType === 'Local') {
      if (!report.outputConfig?.localPath) {
        throw new Error('請填寫本機輸出路徑');
      }
      return;
    }
    if (report.outputType === 'GoogleDrive') {
      if (executionType === 'Test') {
        if (!report.outputConfig?.testFolderId) {
          throw new Error('測試產生請先設定 Google Drive「測試資料夾」');
        }
      } else if (!report.outputConfig?.folderId) {
        throw new Error('請先選擇或填入 Google Drive 資料夾');
      }
      return;
    }
    throw new Error(`不支援的輸出類型：${report.outputType}`);
  }

  /**
   * @param {{ reportId: string, executionType: 'Manual'|'Schedule'|'Test', sqlProfile?: 'test'|'production' }} opts
   */
  async function execute(opts) {
    const reportId = String(opts.reportId || '');
    const executionType = opts.executionType || 'Manual';
    const sqlProfile = opts.sqlProfile === 'production' ? 'production' : 'test';
    if (!reportId) throw new Error('缺少報表 id');

    if (running.has(reportId)) {
      throw new Error('此報表正在執行中，請稍後再試');
    }

    const report = repo.getReport(reportId);
    if (!report) throw new Error('找不到報表');
    if (report.enabled === false) throw new Error('此報表已停用');
    if (!report.sqlQuery) throw new Error('尚未設定 SQL');
    assertDestinationReady(report, executionType);

    running.add(reportId);
    const logId = newId('log');
    const start = new Date();
    const startIso = start.toISOString();
    repo.appendLog({
      id: logId,
      reportId,
      executionType,
      startTime: startIso,
      endTime: null,
      status: 'Running',
      recordCount: null,
      fileName: null,
      destinationType: report.outputType,
      filePath: null,
      googleDriveFolderId: null,
      googleDriveFileId: null,
      errorMessage: null,
      durationMs: null,
      createdAt: startIso
    });

    let tempFile = null;
    try {
      const fileName = buildFileName(report.fileNameBase, report.overwriteMode, start);
      tempFile = path.join(tempDir(), `${logId}.csv`);

      let stream = null;
      let opened = false;
      const queryResult = await sqlRunner.queryForExport(report.sqlQuery, {
        profile: sqlProfile,
        onRow: async (row, cols) => {
          if (!opened) {
            stream = csvWriter.createStreamingFile({
              filePath: tempFile,
              columns: cols,
              serializeCell: sqlRunner.serializeCell,
              fs
            });
            opened = true;
          }
          stream.writeRow(row);
        }
      });

      if (opened && stream) {
        stream.close();
      } else {
        const cols = queryResult.columns || [];
        if (cols.length) {
          stream = csvWriter.createStreamingFile({
            filePath: tempFile,
            columns: cols,
            serializeCell: sqlRunner.serializeCell,
            fs
          });
          stream.close();
        } else {
          const emptyContent = (csvWriter.useBom ? '\uFEFF' : '') + '\r\n';
          fs.writeFileSync(tempFile, emptyContent, 'utf8');
        }
      }

      const provider = outputFactory.getProvider(report.outputType);
      const out = await provider.write(tempFile, fileName, {
        reportId,
        outputType: report.outputType,
        outputConfig: report.outputConfig,
        overwriteMode: report.overwriteMode,
        executionType
      });

      const end = new Date();
      const durationMs = end.getTime() - start.getTime();
      repo.updateLog(logId, {
        endTime: end.toISOString(),
        status: 'Success',
        recordCount: queryResult.recordCount,
        fileName: out.fileName,
        filePath: out.filePath || null,
        googleDriveFolderId: out.googleDriveFolderId || null,
        googleDriveFileId: out.googleDriveFileId || null,
        durationMs,
        errorMessage: null
      });

      if (executionType !== 'Test') {
        const nextRunAt = report.scheduleEnabled && report.schedule
          ? computeNextRunAt(report.schedule, end).toISOString()
          : (report.scheduleEnabled ? report.nextRunAt : null);
        const nextConfig = { ...report.outputConfig };
        if (out.googleDriveFileId && report.outputType === 'GoogleDrive') {
          nextConfig.lastGoogleDriveFileId = out.googleDriveFileId;
        }
        repo.upsertReport({
          ...report,
          outputConfig: nextConfig,
          lastRunAt: end.toISOString(),
          lastStatus: 'Success',
          lastError: null,
          nextRunAt: nextRunAt || null,
          updatedAt: nowIso()
        });
      }

      return {
        executionId: logId,
        fileName: out.fileName,
        filePath: out.filePath || null,
        destinationType: report.outputType,
        googleDriveFileId: out.googleDriveFileId || null,
        googleDriveFolderId: out.googleDriveFolderId || null,
        recordCount: queryResult.recordCount,
        durationMs
      };
    } catch (err) {
      const end = new Date();
      const durationMs = end.getTime() - start.getTime();
      repo.updateLog(logId, {
        endTime: end.toISOString(),
        status: 'Failed',
        durationMs,
        errorMessage: err.message || String(err)
      });
      if (executionType !== 'Test') {
        const latest = repo.getReport(reportId) || report;
        // 排程失敗仍推進 nextRunAt，避免同一 due 每 30s 狂重試；可手動再跑
        let nextRunAt = latest.nextRunAt;
        if (executionType === 'Schedule' && latest.scheduleEnabled && latest.schedule) {
          nextRunAt = computeNextRunAt(latest.schedule, end).toISOString();
        }
        repo.upsertReport({
          ...latest,
          lastRunAt: end.toISOString(),
          lastStatus: 'Failed',
          lastError: err.message || String(err),
          nextRunAt: nextRunAt || null,
          updatedAt: nowIso()
        });
      }
      throw err;
    } finally {
      running.delete(reportId);
      safeUnlink(tempFile);
    }
  }

  return {
    execute,
    isRunning: (id) => running.has(id),
    buildFileName
  };
}

module.exports = { createExportService, buildFileName, formatDateStamp };
