'use strict';

/**
 * App 內報表排程（Phase 3）
 * 只負責「何時」；執行一律走 ReportExportService。
 * 最終會改接系統排程器（Phase 5），此 tick 為過渡觸發器。
 */
const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_CONCURRENCY = 1;

function createReportExportScheduler(deps) {
  let timer = null;
  let tickRunning = false;

  function log(...args) {
    if (typeof deps.log === 'function') deps.log(...args);
    else console.log('[report-export]', ...args);
  }

  async function tick() {
    if (tickRunning) {
      log('scheduler tick skipped (previous still running)');
      return;
    }
    if (typeof deps.isReady === 'function' && !deps.isReady()) return;
    tickRunning = true;
    try {
      const due = typeof deps.listDueReports === 'function'
        ? await deps.listDueReports()
        : [];
      if (!due.length) return;

      const concurrency = Math.max(1, Number(deps.concurrency) || DEFAULT_CONCURRENCY);
      const queue = due.slice();
      const workers = [];

      async function worker() {
        while (queue.length) {
          const report = queue.shift();
          if (!report?.id) continue;
          try {
            log('schedule run', report.id, report.reportName || '');
            await deps.execute({
              reportId: report.id,
              executionType: 'Schedule'
            });
          } catch (err) {
            // 單筆失敗不中止整輪
            log('schedule run failed', report.id, err?.message || String(err));
          }
        }
      }

      for (let i = 0; i < Math.min(concurrency, due.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
    } catch (err) {
      log('scheduler tick failed', err?.message || String(err));
    } finally {
      tickRunning = false;
    }
  }

  return {
    start() {
      if (timer) {
        log('scheduler already running');
        return;
      }
      const ms = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
      log('scheduler started', `${ms}ms`);
      tick();
      timer = setInterval(tick, ms);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log('scheduler stopped');
      }
    },

    tickNow: tick,

    isRunning() {
      return !!timer;
    }
  };
}

module.exports = {
  createReportExportScheduler,
  DEFAULT_INTERVAL_MS,
  DEFAULT_CONCURRENCY
};
