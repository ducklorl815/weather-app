'use strict';

const {
  validateReportExportSql,
  isReportSqlBatch,
  pickPrimaryRecordset
} = require('./sql-validate');

/**
 * 為「單一 SELECT」預覽加上筆數限制。
 * 批次腳本（DECLARE／#temp／多段）不包裝，改在結果集 slice。
 */
function wrapPreviewSql(sql, limit) {
  const text = String(sql || '').trim().replace(/;+\s*$/, '');
  const n = Number(limit) || 100;
  if (isReportSqlBatch(text)) return text;
  if (/\bTOP\s+\(?\d+\)?/i.test(text) || /\bFETCH\s+NEXT\b/i.test(text)) {
    return text;
  }
  if (/^\s*WITH\b/i.test(text)) {
    return `SELECT TOP (${n}) * FROM (\n${text}\n) AS __report_export_preview`;
  }
  return text.replace(/^\s*SELECT\b/i, `SELECT TOP (${n})`);
}

function serializeCell(value) {
  if (value == null) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    const hh = String(value.getHours()).padStart(2, '0');
    const mm = String(value.getMinutes()).padStart(2, '0');
    const ss = String(value.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

function createSqlRunner({
  getSqlPool,
  previewDefaultLimit = 100,
  exportSoftMaxRows = 500000
}) {
  function validate(sql) {
    return validateReportExportSql(sql);
  }

  async function preview(sqlText, { limit = previewDefaultLimit, timeoutMs = 60000, profile } = {}) {
    const safeSql = validate(sqlText);
    const batch = isReportSqlBatch(safeSql);
    const toRun = batch ? safeSql : wrapPreviewSql(safeSql, limit);
    const pool = await getSqlPool(profile);
    const req = pool.request();
    req.timeout = timeoutMs;
    const result = await req.query(toRun);
    let recordset = pickPrimaryRecordset(result);
    const truncated = batch && recordset.length > limit;
    if (batch && truncated) {
      recordset = recordset.slice(0, limit);
    }
    const columns = recordset.length
      ? Object.keys(recordset[0])
      : [];
    const rows = recordset.map((row) => {
      const item = {};
      columns.forEach((col) => {
        item[col] = serializeCell(row[col]);
      });
      return item;
    });
    return {
      columns,
      rows,
      total: rows.length,
      truncated: truncated || (!batch && rows.length >= limit),
      limit,
      sql: toRun,
      batch
    };
  }

  async function queryForExport(sqlText, {
    timeoutMs = 300000,
    softMaxRows = exportSoftMaxRows,
    onRow,
    profile
  } = {}) {
    const safeSql = validate(sqlText);
    const pool = await getSqlPool(profile);
    const req = pool.request();
    req.timeout = timeoutMs;
    const result = await req.query(safeSql);
    const recordset = pickPrimaryRecordset(result);
    if (recordset.length > softMaxRows) {
      throw new Error(`查詢結果超過上限 ${softMaxRows.toLocaleString()} 筆，請縮小 SQL 範圍`);
    }
    const columns = recordset.length ? Object.keys(recordset[0]) : [];
    let recordCount = 0;
    for (const row of recordset) {
      recordCount += 1;
      if (typeof onRow === 'function') {
        await onRow(row, columns, recordCount);
      }
    }
    return { columns, recordCount, sql: safeSql };
  }

  return {
    validate,
    preview,
    queryForExport,
    serializeCell
  };
}

module.exports = { createSqlRunner, wrapPreviewSql, serializeCell };
