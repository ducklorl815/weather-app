'use strict';

const SCHEMA_VERSION = 1;
const MAX_LOGS_GLOBAL = 2000;
const MAX_LOGS_PER_REPORT = 100;

function createRepository({ app, fs, path }) {
  function definitionsPath() {
    return path.join(app.getPath('userData'), 'report-export-definitions.json');
  }

  function logsPath() {
    return path.join(app.getPath('userData'), 'report-export-logs.json');
  }

  function readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' ? data : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(file, data) {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }

  function loadDefinitions() {
    const data = readJson(definitionsPath(), { schemaVersion: SCHEMA_VERSION, reports: [] });
    if (!Array.isArray(data.reports)) data.reports = [];
    data.schemaVersion = SCHEMA_VERSION;
    return data;
  }

  function saveDefinitions(data) {
    writeJson(definitionsPath(), {
      schemaVersion: SCHEMA_VERSION,
      reports: data.reports || []
    });
  }

  function loadLogs() {
    const data = readJson(logsPath(), { schemaVersion: SCHEMA_VERSION, logs: [] });
    if (!Array.isArray(data.logs)) data.logs = [];
    data.schemaVersion = SCHEMA_VERSION;
    return data;
  }

  function saveLogs(data) {
    writeJson(logsPath(), {
      schemaVersion: SCHEMA_VERSION,
      logs: data.logs || []
    });
  }

  function listReports({ includeDisabled = true } = {}) {
    const reports = loadDefinitions().reports.slice();
    const filtered = includeDisabled ? reports : reports.filter((r) => r.enabled !== false);
    filtered.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return filtered;
  }

  function getReport(id) {
    return loadDefinitions().reports.find((r) => r.id === id) || null;
  }

  function upsertReport(report) {
    const data = loadDefinitions();
    const idx = data.reports.findIndex((r) => r.id === report.id);
    if (idx >= 0) data.reports[idx] = report;
    else data.reports.push(report);
    saveDefinitions(data);
    return report;
  }

  function listLogs(reportId, { limit = 50, offset = 0 } = {}) {
    const logs = loadLogs().logs
      .filter((l) => l.reportId === reportId)
      .sort((a, b) => String(b.startTime || '').localeCompare(String(a.startTime || '')));
    return logs.slice(offset, offset + limit);
  }

  function appendLog(log) {
    const data = loadLogs();
    data.logs.unshift(log);
    // per-report trim
    const byReport = new Map();
    const kept = [];
    for (const item of data.logs) {
      const key = item.reportId || '_';
      const count = byReport.get(key) || 0;
      if (count >= MAX_LOGS_PER_REPORT) continue;
      byReport.set(key, count + 1);
      kept.push(item);
      if (kept.length >= MAX_LOGS_GLOBAL) break;
    }
    data.logs = kept;
    saveLogs(data);
    return log;
  }

  function updateLog(id, patch) {
    const data = loadLogs();
    const idx = data.logs.findIndex((l) => l.id === id);
    if (idx < 0) return null;
    data.logs[idx] = { ...data.logs[idx], ...patch };
    saveLogs(data);
    return data.logs[idx];
  }

  function listDueReports(now = new Date()) {
    const t = now instanceof Date ? now : new Date(now);
    return listReports({ includeDisabled: false }).filter((r) => {
      if (!r.scheduleEnabled || !r.schedule) return false;
      if (!r.nextRunAt) return true; // 缺 next → 視為 due，由執行後補算
      const next = new Date(r.nextRunAt);
      return !Number.isNaN(next.getTime()) && next <= t;
    });
  }

  return {
    listReports,
    getReport,
    upsertReport,
    listLogs,
    appendLog,
    updateLog,
    listDueReports
  };
}

module.exports = { createRepository };
