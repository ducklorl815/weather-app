'use strict';
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'renderer', 'shell', 'app.js');
let s = fs.readFileSync(p, 'utf8');

const markers = [
  { needle: '        window.onload = async () => {', banner: '【MODULE: Boot / Session】啟動、登入檢查、session hint' },
  { needle: '        function initWeatherAndClock', banner: '【MODULE: weather-focus】天氣／時鐘／Focus（header chrome）' },
  { needle: '        function toggleBugReportPanel', banner: '【MODULE: bug-report】Bug／優化回報面板' },
  { needle: '        async function loginGoogle', banner: '【MODULE: Authorization】登入／功能授權閘道' },
  { needle: '        // [MODULE: Mosaic / WIDGET_CATALOG]', banner: '【MODULE: Mosaic】加入功能／拼貼引擎／Partial 掛載' },
  { needle: '        let currentTasks = {}', banner: '【FEATURE: tasks】待辦（邏輯待下沉 features/tasks/logic.js）' },
  { needle: '        async function loadCalendar', banner: '【FEATURE: calendar】日曆（邏輯待下沉 features/calendar/logic.js）' },
  { needle: '        async function loadSheets', banner: '【FEATURE: sheets】9527（邏輯待下沉 features/sheets/logic.js）' },
  { needle: '        async function loadSitesVisits', banner: '【FEATURE: sitesVisits】網站瀏覽紀錄' },
  { needle: '        async function loadGmail', banner: '【FEATURE: gmail】未讀郵件' },
  { needle: '        async function loadGchat', banner: '【FEATURE: gchat】Little Reply' },
  { needle: '        function showCreateEventModal', banner: '【FEATURE: calendar】建立行程表單' },
  { needle: '        function toggleThemeMenu', banner: '【MODULE: settings】主題／字級／更新／Tray' },
  { needle: '        async function mountChat', banner: '【FEATURE: chat】詢問機器人' },
  { needle: '        function logoutApp', banner: '【MODULE: Authorization】登出' }
];

for (const { needle, banner } of markers) {
  const guard = `// ========== ${banner} ==========`;
  if (s.includes(guard)) continue;
  const idx = s.indexOf(needle);
  if (idx < 0) {
    console.warn('not found:', needle.slice(0, 50));
    continue;
  }
  s = s.slice(0, idx) + `\n        ${guard}\n` + s.slice(idx);
  console.log('banner:', banner);
}

fs.writeFileSync(p, s);
console.log('app.js banners done');
