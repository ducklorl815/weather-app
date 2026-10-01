'use strict';

/**
 * 報表匯出 SQL 防呆
 * ----------------------------------------------------------------------------
 * 允許：USE / DECLARE / SET / 多段 SELECT / SELECT INTO #temp /
 *       DROP TABLE #temp（僅暫存表，供腳本重建 #表）/ WITH (NOLOCK)
 * 禁止：任何 UPDATE / DELETE；DROP 正式表；INSERT 正式表；EXEC／TRUNCATE／ALTER…
 */

function stripSqlNoise(sql) {
  let s = String(sql || '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/--[^\n\r]*/g, ' ');
  s = s.replace(/N?'(?:''|[^'])*'/gi, "''");
  return s;
}

function isTempName(name) {
  const n = String(name || '').replace(/[\[\]]/g, '').trim();
  return n.startsWith('#');
}

function validateReportExportSql(sql) {
  const raw = String(sql || '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('請輸入 SQL');

  const scan = stripSqlNoise(raw);

  if (/\b(TRUNCATE|ALTER|MERGE|EXEC|EXECUTE|GRANT|REVOKE|BACKUP|RESTORE|SHUTDOWN|OPENROWSET|OPENDATASOURCE|BULK\s+INSERT)\b/i.test(scan)) {
    throw new Error('不允許 TRUNCATE／ALTER／EXEC／MERGE 等會改資料或執行程序的語法');
  }
  if (/\bxp_/i.test(scan)) {
    throw new Error('不允許呼叫 xp_ 擴充程序');
  }

  // 全面禁止 UPDATE / DELETE（含暫存表）
  if (/\bUPDATE\b/i.test(scan)) {
    throw new Error('不允許 UPDATE（報表僅能查詢）');
  }
  if (/\bDELETE\b/i.test(scan)) {
    throw new Error('不允許 DELETE（報表僅能查詢）');
  }

  const createRe = /\bCREATE\s+(VIEW|PROC|PROCEDURE|FUNCTION|TRIGGER|SCHEMA|DATABASE|INDEX|UNIQUE|CLUSTERED|NONCLUSTERED)\b/i;
  if (createRe.test(scan)) {
    throw new Error('不允許建立 View／Stored Procedure 等物件');
  }
  let m;
  const createTableRe = /\bCREATE\s+TABLE\s+(\[?#?[\w.]+\]?)/gi;
  while ((m = createTableRe.exec(scan))) {
    if (!isTempName(m[1])) {
      throw new Error('只允許 CREATE TABLE 暫存表（名稱以 # 開頭）');
    }
  }

  // DROP：只允許 #temp
  const dropRe = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\[?#?[\w.]+\]?)/gi;
  while ((m = dropRe.exec(scan))) {
    if (!isTempName(m[1])) {
      throw new Error('只允許 DROP 暫存表（#開頭），不可 DROP 正式資料表');
    }
  }
  if (/\bDROP\s+(VIEW|PROC|PROCEDURE|FUNCTION|TRIGGER|DATABASE|SCHEMA|INDEX)\b/i.test(scan)) {
    throw new Error('不允許 DROP 正式資料庫物件');
  }

  // INSERT：只允許 #temp（少用；主要靠 SELECT INTO #）
  const insertRe = /\bINSERT\s+(?:INTO\s+)?(\[?#?[\w.]+\]?)/gi;
  while ((m = insertRe.exec(scan))) {
    if (!isTempName(m[1])) {
      throw new Error('不允許 INSERT 到正式資料表');
    }
  }

  // SELECT INTO：只允許 #temp
  const intoRe = /\bINTO\s+(\[?#?[\w.]+\]?)/gi;
  while ((m = intoRe.exec(scan))) {
    const target = m[1];
    if (target.startsWith('@')) continue;
    if (!isTempName(target)) {
      throw new Error('SELECT INTO 只允許寫入暫存表（#開頭）');
    }
  }

  if (!/\bSELECT\b/i.test(scan)) {
    throw new Error('報表 SQL 至少需要一個 SELECT');
  }

  return raw;
}

function isReportSqlBatch(sql) {
  const s = stripSqlNoise(sql);
  if (/\b(DECLARE|USE\s+\w+|DROP\s+TABLE|CREATE\s+TABLE|INTO\s+#)\b/i.test(s)) return true;
  const parts = s.split(';').map((p) => p.trim()).filter(Boolean);
  return parts.length > 1;
}

function pickPrimaryRecordset(result) {
  const sets = Array.isArray(result?.recordsets) ? result.recordsets : [];
  for (let i = sets.length - 1; i >= 0; i--) {
    const rs = sets[i];
    if (!rs) continue;
    if (Array.isArray(rs) && rs.length > 0) return rs;
    if (rs.columns && Object.keys(rs.columns).length > 0) return rs;
  }
  if (Array.isArray(result?.recordset)) return result.recordset;
  return [];
}

module.exports = {
  validateReportExportSql,
  isReportSqlBatch,
  pickPrimaryRecordset,
  stripSqlNoise
};
