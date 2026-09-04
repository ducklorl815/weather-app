/**
 * LifeTour × Google Sites 瀏覽追蹤
 *
 * 部署網址必須是：https://script.google.com/macros/s/XXXX/exec
 * （若出現「無法開啟這個檔案／雲端硬碟」，代表貼錯成 Drive 或編輯器網址）
 *
 * 造訪：每次進入網頁 +1（約 90 秒內重複載入不重複計，避免 iframe 重載誤算）
 * 點擊：嵌入區需點「點擊監控區」；或 ?event=click 再按確認才 +1
 * 超連結：?event=link&url=… 再按「前往並計數」才 +1（開啟頁面不計）
 * 停留時間：嵌入頁每約 10 秒回報實際可見秒數（分頁隱藏時暫停），不是固定 +30 秒
 *
 * 權限：執行身分＝我；誰可以存取＝網域內的所有人
 * 改碼後務必：管理部署 → 編輯 → 新版本
 *
 * ★ 若同仁看到「LOG_SHEET_ID 未設定」：把下面這行改成 LifeTour 設定頁顯示的試算表 ID
 */
var LOG_SHEET_ID = '1JeXwEmgaaYlDpX8Fb2dicCO60Tsq6P__Irxld3OlT_Y';
var LOG_SHEET_NAME = '瀏覽紀錄';
var PROJECTS = [
  {
    "id": "site_mt6plccd",
    "name": "SiteSQ",
    "siteId": "1ZV6Hz0wLW03MhIyV0X-ovneFzv6oUPUq",
    "pageId": "",
    "siteSlug": "",
    "url": "https://sites.google.com/d/1ZV6Hz0wLW03MhIyV0X-ovneFzv6oUPUq/view"
  }
];

function getLogSheetId_() {
  var id = String(LOG_SHEET_ID || '').trim();
  if (id && id !== 'PASTE_SPREADSHEET_ID') return id;
  try {
    id = String(PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID') || '').trim();
  } catch (e1) { id = ''; }
  if (id && id !== 'PASTE_SPREADSHEET_ID') return id;
  throw new Error('LOG_SHEET_ID 未設定：請在 Apps Script 開頭把 LOG_SHEET_ID 改成 LifeTour 顯示的試算表 ID，再「管理部署→新版本」');
}

function rememberLogSheetId_(raw) {
  var id = String(raw || '').trim();
  if (!id || id === 'PASTE_SPREADSHEET_ID') return '';
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(id)) return '';
  try { PropertiesService.getScriptProperties().setProperty('LOG_SHEET_ID', id); } catch (e2) {}
  LOG_SHEET_ID = id;
  return id;
}

function safeHttpUrl_(u) {
  u = String(u || '').trim();
  if (!/^https?:\/\//i.test(u)) return '';
  return u;
}

function page_(body, title) {
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + (title || 'LifeTour') + '</title></head>' +
    '<body style="margin:0;font:13px/1.45 sans-serif;padding:12px;color:#333;background:#fff;">' +
    body + '</body></html>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doGet(e) {
  var siteId = '';
  var eventName = 'open';
  var label = '';
  var targetUrl = '';
  var logSheetParam = '';
  try {
    siteId = String((e && e.parameter && (e.parameter.siteId || e.parameter.project)) || '');
    eventName = String((e && e.parameter && e.parameter.event) || 'open').toLowerCase();
    label = String((e && e.parameter && e.parameter.label) || '');
    targetUrl = safeHttpUrl_((e && e.parameter && (e.parameter.url || e.parameter.to || e.parameter.href)) || '');
    logSheetParam = String((e && e.parameter && (e.parameter.logSheet || e.parameter.logSpreadsheetId)) || '');
  } catch (err1) {}
  if (logSheetParam) rememberLogSheetId_(logSheetParam);
  if (!siteId && PROJECTS && PROJECTS.length === 1) {
    siteId = String(PROJECTS[0].siteId || PROJECTS[0].siteSlug || '');
  }

  if (eventName === 'click') {
    // 不在伺服器 GET 記數；必須使用者再按一次按鈕才 +1
    var clickHtml = HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'body{margin:0;font:14px/1.5 sans-serif;padding:24px;color:#333;text-align:center;background:#fff;}' +
      '#go{font:14px sans-serif;padding:10px 18px;cursor:pointer;margin-top:14px;}' +
      '</style></head><body>' +
      '<div id="msg">請確認點擊' + (label ? ('「' + label + '」') : '') + '</div>' +
      '<button type="button" id="go">確認點擊並返回</button>' +
      '<script>' +
      'var SITE_ID=' + JSON.stringify(siteId) + ';' +
      'var LABEL=' + JSON.stringify(label || 'button') + ';' +
      'var done=false;' +
      'function go(){' +
      '  if(done) return; done=true;' +
      '  var msg=document.getElementById("msg");' +
      '  if(msg) msg.textContent="已記錄點擊…";' +
      '  function back(){ setTimeout(function(){ history.length>1 ? history.back() : null; }, 400); }' +
      '  if(!(window.google&&google.script&&google.script.run)){ back(); return; }' +
      '  google.script.run.withSuccessHandler(back).withFailureHandler(back).logVisit(SITE_ID, 0, "click", LABEL);' +
      '}' +
      'document.getElementById("go").addEventListener("click", go);' +
      '</script></body></html>'
    );
    clickHtml.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    return clickHtml;
  }

  if (eventName === 'link' || eventName === 'redirect') {
    if (!targetUrl) {
      return page_('<div>缺少 url 參數，無法轉址（超連結未計數）</div>');
    }
    // 必須再按「前往」才記數並轉址（開啟頁面／預抓不計）
    var linkHtml = HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'body{margin:0;font:14px/1.5 sans-serif;padding:24px;color:#333;text-align:center;background:#fff;}' +
      '#go{font:14px sans-serif;padding:10px 18px;cursor:pointer;margin-top:14px;}' +
      '</style></head><body>' +
      '<div id="msg">即將前往' + (label ? ('「' + label + '」') : '目標頁面') + '<br><small>請再按一次下方按鈕才會計入超連結</small></div>' +
      '<button type="button" id="go">前往並計數</button>' +
      '<script>' +
      'var SITE_ID=' + JSON.stringify(siteId) + ';' +
      'var LABEL=' + JSON.stringify(label || targetUrl) + ';' +
      'var TARGET=' + JSON.stringify(targetUrl) + ';' +
      'var done=false;' +
      'function finish(){ try{ location.replace(TARGET); }catch(e){ location.href=TARGET; } }' +
      'function go(){' +
      '  if(done) return; done=true;' +
      '  var msg=document.getElementById("msg");' +
      '  if(msg) msg.textContent="記錄中，即將轉址…";' +
      '  if(!(window.google&&google.script&&google.script.run)){ finish(); return; }' +
      '  google.script.run' +
      '    .withSuccessHandler(function(){ finish(); })' +
      '    .withFailureHandler(function(){ finish(); })' +
      '    .logVisit(SITE_ID, 0, "link", LABEL);' +
      '}' +
      'document.getElementById("go").addEventListener("click", go);' +
      '</script></body></html>'
    );
    linkHtml.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    linkHtml.setTitle('LifeTour link');
    return linkHtml;
  }

  var openErr = '';
  try { logVisit(siteId, 0, 'open', ''); } catch (err2) { openErr = String(err2 && err2.message || err2); }

  var status = openErr
    ? ('<div style="color:#b00;font-size:12px;line-height:1.5;">寫入失敗：' + openErr +
      '<br><br>請更新嵌入網址，加上 logSheet=你的試算表ID，或修正 Apps Script 的 LOG_SHEET_ID 後部署新版本。</div>')
    : ('<div style="color:#6a6;font-size:11px;">追蹤就緒 · siteId=' + (siteId || '(空)') + '</div>');

  var html = HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;width:100%;height:100%;min-height:120px;background:transparent;}' +
    '#wrap{box-sizing:border-box;width:100%;height:100%;min-height:120px;padding:8px;}' +
    '#hit{box-sizing:border-box;width:100%;min-height:72px;cursor:pointer;' +
    'display:flex;align-items:center;justify-content:center;font:12px/1.4 sans-serif;color:#9aa;' +
    'border:1px dashed rgba(0,0,0,.12);border-radius:8px;user-select:none;}' +
    '#hit:active{background:rgba(0,0,0,.04);}' +
    '</style></head><body><div id="wrap">' + status +
    '<div id="hit" title="點此區塊可記錄互動點擊">點擊監控區</div></div>' +
    '<script>' +
    'var SITE_ID=' + JSON.stringify(siteId) + ';' +
    'var lastClick=0;' +
    'var lastBeatAt=Date.now();' +
    'var visibleSince=document.hidden?0:Date.now();' +
    'function send(kind,label,secs){' +
    '  var n = (kind==="beat") ? Math.max(0, Math.min(120, Math.round(Number(secs)||0))) : 0;' +
    '  if(kind==="beat" && n<=0) return;' +
    '  google.script.run.withFailureHandler(function(err){' +
    '    var el=document.getElementById("hit"); if(el) el.textContent="失敗："+String(err&&err.message||err);' +
    '  }).logVisit(SITE_ID, n, kind, label||"");' +
    '}' +
    'function flushBeat(){' +
    '  if(document.hidden) return;' +
    '  var now=Date.now();' +
    '  var sec=Math.round((now-lastBeatAt)/1000);' +
    '  lastBeatAt=now;' +
    '  if(sec>0) send("beat","",sec);' +
    '}' +
    'function onHit(ev){' +
    '  if(ev){ ev.preventDefault(); ev.stopPropagation(); }' +
    '  var now=Date.now(); if(now-lastClick<800) return; lastClick=now;' +
    '  send("click", "embed");' +
    '  var el=document.getElementById("hit");' +
    '  if(el){ el.textContent="已點擊 ✓"; setTimeout(function(){ el.textContent="點擊監控區"; }, 700); }' +
    '}' +
    'document.getElementById("hit").addEventListener("click", onHit);' +
    'document.addEventListener("visibilitychange", function(){' +
    '  if(document.hidden){ flushBeat(); visibleSince=0; }' +
    '  else { lastBeatAt=Date.now(); visibleSince=Date.now(); }' +
    '});' +
    'window.addEventListener("pagehide", flushBeat);' +
    'window.addEventListener("beforeunload", flushBeat);' +
    'setInterval(flushBeat, 10000);' +
    '</script></body></html>'
  );
  html.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  html.setTitle('LifeTour tracker');
  return html;
}

function resolveProject(siteId) {
  var key = String(siteId || '');
  var keyLower = key.toLowerCase();
  for (var i = 0; i < (PROJECTS || []).length; i++) {
    var p = PROJECTS[i];
    if (!p) continue;
    if (p.siteId && p.siteId === key) return p;
    if (p.pageId && p.pageId === key) return p;
    if (p.id && p.id === key) return p;
    if (p.name && p.name === key) return p;
    if (p.siteSlug && String(p.siteSlug).toLowerCase() === keyLower) return p;
    if (p.url && key && String(p.url).indexOf(key) >= 0) return p;
  }
  if (!key && PROJECTS && PROJECTS.length === 1) return PROJECTS[0] || {};
  return {};
}

function ensureHeader_(sh) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(['時間', '同仁', '專案', '網站', '秒數', 'SiteID', '點擊數', '超連結數']);
    return;
  }
  var head = sh.getRange(1, 1, 1, 8).getValues()[0];
  if (String(head[6] || '') !== '點擊數') sh.getRange(1, 7).setValue('點擊數');
  if (String(head[7] || '') !== '超連結數') sh.getRange(1, 8).setValue('超連結數');
}

function findSessionRow_(sh, sid, projectName, person, now, SESSION_MS) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var vals = sh.getRange(2, 1, last, 8).getValues();
  var personKey = String(person || '');
  for (var r = vals.length - 1; r >= 0; r--) {
    var rowSid = String(vals[r][5] || '');
    var rowProject = String(vals[r][2] || '');
    var rowPerson = String(vals[r][1] || '');
    var rowTime = vals[r][0] ? new Date(vals[r][0]).getTime() : 0;
    if (SESSION_MS > 0 && !(rowTime && (now - rowTime) <= SESSION_MS)) continue;
    // 必須同一同仁，避免多人互相覆寫成一列
    if (personKey && personKey !== '未知同仁' && rowPerson && rowPerson !== personKey) continue;
    if (personKey === '未知同仁' && rowPerson && rowPerson !== '未知同仁') continue;
    if ((sid && rowSid === sid) || (projectName && rowProject === projectName)) return r + 2;
  }
  return -1;
}

function touchSession_(sh, row, person) {
  sh.getRange(row, 1).setValue(new Date());
  if (person && person !== '未知同仁') {
    var cur = String(sh.getRange(row, 2).getValue() || '');
    if (!cur || cur === '未知同仁') sh.getRange(row, 2).setValue(person);
  }
}

function logVisit(siteId, seconds, kind, label) {
  kind = kind || 'open';
  label = label || '';
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheetIdResolved = getLogSheetId_();
    var ss = SpreadsheetApp.openById(sheetIdResolved);
    var sh = ss.getSheetByName(LOG_SHEET_NAME) || ss.insertSheet(LOG_SHEET_NAME);
    ensureHeader_(sh);
    var user = '';
    try {
      user = Session.getActiveUser().getEmail() || '';
      if (!user) user = Session.getEffectiveUser().getEmail() || '';
    } catch (err) {}
    var meta = resolveProject(siteId);
    if ((!siteId || !String(siteId)) && (meta.siteId || meta.siteSlug)) {
      siteId = meta.siteId || meta.siteSlug;
    }
    var sid = String(siteId || meta.siteId || meta.siteSlug || '');
    var person = user || '未知同仁';
    var projectName = meta.name || sid || '未命名';
    var siteUrl = meta.url || '';
    // 造訪：每次進入都算，僅 90 秒內防 iframe 重載
    var OPEN_DEBOUNCE_MS = 90 * 1000;
    // 點擊／超連結／心跳：寫入「最近一次造訪」列（12 小時內）
    var ACTIVE_VISIT_MS = 12 * 60 * 60 * 1000;
    var addSec = (kind === 'beat') ? Math.max(0, Number(seconds) || 0) : 0;
    var now = new Date().getTime();
    var cache = CacheService.getScriptCache();
    var openCacheKey = 'open_' + sid + '_' + person;

    if (kind === 'open') {
      if (sid && cache.get(openCacheKey)) {
        var dup = findSessionRow_(sh, sid, projectName, person, now, OPEN_DEBOUNCE_MS);
        if (dup > 0) touchSession_(sh, dup, person);
        return;
      }
      var recentOpen = findSessionRow_(sh, sid, projectName, person, now, OPEN_DEBOUNCE_MS);
      if (recentOpen > 0) {
        touchSession_(sh, recentOpen, person);
        if (sid) cache.put(openCacheKey, '1', 90);
        return;
      }
      sh.appendRow([new Date(), person, projectName, siteUrl, 0, sid, 0, 0]);
      if (sid) cache.put(openCacheKey, '1', 90);
      return;
    }

    var row = findSessionRow_(sh, sid, projectName, person, now, ACTIVE_VISIT_MS);

    if (kind === 'click') {
      if (row > 0) {
        var prevClicks = Number(sh.getRange(row, 7).getValue()) || 0;
        touchSession_(sh, row, person);
        sh.getRange(row, 7).setValue(prevClicks + 1);
        return;
      }
      sh.appendRow([new Date(), person, projectName, siteUrl, 0, sid, 1, 0]);
      return;
    }

    if (kind === 'link' || kind === 'redirect') {
      if (row > 0) {
        var prevLinks = Number(sh.getRange(row, 8).getValue()) || 0;
        touchSession_(sh, row, person);
        sh.getRange(row, 8).setValue(prevLinks + 1);
        return;
      }
      sh.appendRow([new Date(), person, projectName, siteUrl, 0, sid, 0, 1]);
      return;
    }

    if (kind === 'beat') {
      if (row < 0) return;
      var prevSec = Number(sh.getRange(row, 5).getValue()) || 0;
      touchSession_(sh, row, person);
      sh.getRange(row, 5).setValue(prevSec + addSec);
      return;
    }
  } finally {
    lock.releaseLock();
  }
}
