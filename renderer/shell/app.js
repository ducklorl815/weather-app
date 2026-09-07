/**
 * ============================================================================
 * Shell App JS — 登入閘道、mosaic 引擎、共用工具、WIDGET_CATALOG 註冊
 * ----------------------------------------------------------------------------
 * [Important]
 * - 這是「大框架」前端邏輯；各功能細節在 renderer/features/<id>/logic.js
 * - 「加入功能」透過 PartialViews.load(type) 載入 view.html
 *
 * 組織（搜尋這些標題即可跳轉）：
 * 1. Boot / Session
 * 2. Weather / Focus / Bug Report（header chrome）
 * 3. Auth / Workspace
 * 4. Mosaic / WIDGET_CATALOG / Dist Features
 * 5. Shared helpers
 * 6. Feature logic（暫仍同檔；逐步下沉到 features/<id>/logic.js）
 * 7. Theme / Settings / Update
 * ============================================================================
 */

        // 修正後的正確結構：window.onload 獨立，loginGoogle 獨立在全域


        // ========== 【MODULE: Boot / Session】啟動、登入檢查、session hint ==========
        const REFRESH_MS = {
            mail: 60 * 1000,
            sheets: 60 * 1000,
            sitesVisits: 60 * 1000,
            gchat: 30 * 1000
        };

        window.onload = async () => {
            initWeatherAndClock();
            try { await refreshAppVersionInfo(); } catch (_) {}
            bindSessionRecovery();
            const loginRes = await window.api.checkLogin();
            paintCredentialProbe(loginRes?.credentialProbe, loginRes);
            if (loginRes.success || loginRes.offline || loginRes.hasTokens) {
                showWorkspace();
                if (loginRes.offline) updateSessionHint({ offline: true, error: loginRes.error });
                if (loginRes.needsReconnect) updateSessionHint({ authRevoked: true, error: loginRes.error });
            } else {
                showAuthScreen(loginRes);
            }
        };

        let sessionOffline = false;
        let sessionNeedsReconnect = false;
        // [Important] 重新連結／首次登入共用的完整功能授權清單
        const ALL_GOOGLE_FEATURE_TYPES = ['calendar', 'tasks', 'gmail', 'gchat', 'sheets', 'sitesVisits', 'chat'];

        function paintCredentialProbe(probe, loginRes = {}) {
            const summaryEl = document.getElementById('auth-probe-summary');
            const detailsEl = document.getElementById('auth-probe-details');
            const preEl = document.getElementById('auth-probe-pre');
            const reconnectBtn = document.getElementById('btn-reconnect-google');
            if (!probe) {
                if (summaryEl) summaryEl.hidden = true;
                if (detailsEl) detailsEl.hidden = true;
                if (reconnectBtn) reconnectBtn.hidden = true;
                return;
            }
            if (summaryEl) {
                summaryEl.hidden = false;
                summaryEl.textContent = probe.message || '';
            }
            if (detailsEl && preEl) {
                detailsEl.hidden = false;
                detailsEl.open = false;
                preEl.textContent = JSON.stringify({
                    userDataPath: probe.userDataPath,
                    tokenPath: probe.tokenPath,
                    hasCredential: probe.hasCredential,
                    hasRefreshToken: probe.hasRefreshToken,
                    reason: probe.reason,
                    authStatus: probe.authStatus || loginRes.authStatus,
                    migratedFrom: probe.migratedFrom || null,
                    alternateTokenPaths: probe.alternateTokenPaths || []
                }, null, 2);
            }
            if (reconnectBtn) {
                const showReconnect = !!(loginRes.needsReconnect || probe.reason === 'present_but_unusable' || probe.hasCredential);
                reconnectBtn.hidden = !showReconnect || !!loginRes.success;
            }
        }

        function showAuthScreen(loginRes = {}) {
            const auth = document.getElementById('auth-container');
            const dash = document.getElementById('dashboard-shell');
            if (auth) auth.style.display = '';
            if (dash) dash.style.display = 'none';
            paintCredentialProbe(loginRes.credentialProbe, loginRes);
        }

        function updateSessionHint(status = {}) {
            sessionOffline = !!status.offline;
            const el = document.getElementById('session-hint');
            if (!el) return;
            if (status.authRevoked || status.authStatus === 'AUTH_REVOKED' || status.needsReconnect) {
                sessionNeedsReconnect = true;
                el.hidden = false;
                el.textContent = '⚠ Google 授權已失效 — 點此重新連結';
                el.title = status.error || '將開啟授權流程，不會先清除本機登入檔';
            } else if (status.offline || status.authStatus === 'OFFLINE') {
                sessionNeedsReconnect = false;
                el.hidden = false;
                el.textContent = '⚠ 離線中（授權仍保留）— 點此重連';
                el.title = status.error || '網路恢復後會自動重連';
            } else if (status.authStatus === 'AUTH_REFRESHING') {
                sessionNeedsReconnect = false;
                el.hidden = false;
                el.textContent = '正在更新授權…';
                el.title = '';
            } else if (status.authed || status.authStatus === 'AUTHENTICATED') {
                sessionNeedsReconnect = false;
                el.hidden = true;
                el.textContent = '';
            }
        }

        /** 授權失效：預設走 Reconnect（不刪檔）；確認後才 Logout */
        async function reconnectGoogleSession() {
            const btn = document.getElementById('btn-reconnect-google');
            const hint = document.getElementById('session-hint');
            try {
                if (btn) btn.textContent = '重新連結中…';
                if (hint && sessionNeedsReconnect) hint.textContent = '重新連結中…';
                const res = await window.api.reconnectGoogle?.();
                if (res?.success) {
                    sessionNeedsReconnect = false;
                    updateSessionHint({ authed: true, authStatus: 'AUTHENTICATED' });
                    showWorkspace();
                    refreshAll();
                    return true;
                }
                alert(res?.error || '重新連結失敗');
                if (confirm('重新連結失敗。要清除本機登入並重啟（登出重整）嗎？')) {
                    window.api.logout();
                }
                return false;
            } catch (err) {
                alert(err?.message || '重新連結失敗');
                return false;
            } finally {
                if (btn) btn.textContent = '重新連結 Google（不清除本機登入檔）';
            }
        }

        function logoutRelaunchForAuth() {
            if (confirm('將清除本機登入紀錄並重啟。若只要重新授權，請改按「取消」後使用重新連結。\n\n確定要登出重整嗎？')) {
                window.api.logout();
            }
        }

        /** session-hint：失效 → Reconnect；離線 → ensureSession */
        async function onSessionHintClick() {
            if (sessionNeedsReconnect) {
                await reconnectGoogleSession();
                return;
            }
            await recoverSessionNow();
        }

        async function recoverSessionNow() {
            if (sessionNeedsReconnect) {
                await reconnectGoogleSession();
                return;
            }
            const el = document.getElementById('session-hint');
            if (el) el.textContent = '重連中…';
            try {
                const res = await window.api.ensureSession();
                updateSessionHint(res);
                if (res?.needsReconnect || res?.authRevoked) {
                    await reconnectGoogleSession();
                    return;
                }
                if (res?.success || res?.offline) refreshAll();
            } catch (_) {
                if (el) el.textContent = '⚠ 離線中（授權仍保留）— 點此重連';
            }
        }

        function bindSessionRecovery() {
            window.addEventListener('online', () => recoverSessionNow());
            window.api.onSessionStatus?.((status) => {
                updateSessionHint(status);
                if (status?.authed && !status?.offline && sessionOffline) {
                    refreshAll();
                }
            });
        }

        async function ensureSessionForWidget() {
            try {
                const res = await window.api.ensureSession();
                updateSessionHint(res);
                return !!(res?.success || res?.offline);
            } catch (_) {
                return sessionOffline;
            }
        }

        async function refreshWidget(type) {
            if (!(await ensureSessionForWidget())) return;
            const def = WIDGET_CATALOG[type];
            def?.mount?.();
        }

        const WEATHER_LOC_KEY = 'weather-location-v1';
        const DEFAULT_WEATHER_LOC = {
            name: '台北市',
            latitude: 25.0478,
            longitude: 121.5319,
            timezone: 'Asia/Taipei'
        };

        let weatherLoc = { ...DEFAULT_WEATHER_LOC };
        let weatherSearchTimer = null;
        let clockTimer = null;
        let focusTimer = null;
        let focusRemaining = 25 * 60;
        let focusRunning = false;

        function loadWeatherLoc() {
            try {
                const raw = JSON.parse(localStorage.getItem(WEATHER_LOC_KEY) || 'null');
                if (raw?.latitude && raw?.longitude && raw?.name) weatherLoc = raw;
            } catch (_) {}
        }

        function saveWeatherLoc(loc) {
            weatherLoc = loc;
            localStorage.setItem(WEATHER_LOC_KEY, JSON.stringify(loc));
        }

        function updateLocalClock() {
            const el = document.getElementById('local-clock');
            if (!el) return;
            try {
                el.textContent = new Date().toLocaleTimeString('zh-TW', {
                    timeZone: weatherLoc.timezone || 'Asia/Taipei',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                });
            } catch (_) {
                el.textContent = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            }
        }

        function formatFocus(sec) {
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }

        function renderFocusBtn() {
            const btn = document.getElementById('focus-btn');
            if (!btn) return;
            btn.classList.toggle('is-running', focusRunning);
            btn.textContent = focusRunning || focusRemaining < 25 * 60
                ? `Focus ${formatFocus(focusRemaining)}`
                : 'Focus';
        }

        function toggleFocusTimer() {
            if (focusRunning) {
                clearInterval(focusTimer);
                focusTimer = null;
                focusRunning = false;
                renderFocusBtn();
                return;
            }
            if (focusRemaining <= 0) focusRemaining = 25 * 60;
            focusRunning = true;
            renderFocusBtn();
            focusTimer = setInterval(() => {
                focusRemaining -= 1;
                if (focusRemaining <= 0) {
                    clearInterval(focusTimer);
                    focusTimer = null;
                    focusRunning = false;
                    focusRemaining = 25 * 60;
                    renderFocusBtn();
                    try { if (window.Notification) new window.Notification('Focus', { body: '時間到，休息一下。' }); } catch (_) {}
                    alert('Focus 時間到');
                    return;
                }
                renderFocusBtn();
            }, 1000);
        }

        async function loadWeatherForLoc() {
            const btn = document.getElementById('weather-loc-btn');
            if (btn) btn.textContent = `📍 ${weatherLoc.name}`;
            const tz = encodeURIComponent(weatherLoc.timezone || 'Asia/Taipei');
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${weatherLoc.latitude}&longitude=${weatherLoc.longitude}&current=temperature_2m,relative_humidity_2m&daily=precipitation_probability_max&timezone=${tz}&forecast_days=1`;
            try {
                const weatherRes = await window.api.fetchWeather(url);
                if (weatherRes?.success && weatherRes.data?.current) {
                    document.getElementById('w-temp').textContent = weatherRes.data.current.temperature_2m ?? '--';
                    document.getElementById('w-hum').textContent = weatherRes.data.current.relative_humidity_2m ?? '--';
                    const rain = weatherRes.data.daily?.precipitation_probability_max?.[0];
                    document.getElementById('w-rain').textContent = rain ?? '--';
                } else {
                    document.getElementById('w-temp').textContent = '--';
                    document.getElementById('w-hum').textContent = '--';
                    document.getElementById('w-rain').textContent = '--';
                    console.warn('天氣讀取失敗', weatherRes?.error || weatherRes);
                }
            } catch (err) {
                console.warn('天氣讀取例外', err);
            }
            updateLocalClock();
        }

        function toggleWeatherSearch(event) {
            event?.stopPropagation?.();
            const panel = document.getElementById('weather-search-panel');
            if (!panel) return;
            const open = panel.classList.toggle('open');
            if (open) {
                const input = document.getElementById('weather-search-input');
                input?.focus();
                input?.select?.();
                if (!(input?.value || '').trim()) {
                    showTaiwanCityPresets();
                }
            }
        }

        function closeWeatherSearch() {
            document.getElementById('weather-search-panel')?.classList.remove('open');
        }

        function onWeatherSearchInput() {
            clearTimeout(weatherSearchTimer);
            weatherSearchTimer = setTimeout(runWeatherSearch, 280);
        }

        function onWeatherSearchKey(event) {
            if (event.key === 'Escape') closeWeatherSearch();
            if (event.key === 'Enter') {
                event.preventDefault();
                runWeatherSearch();
            }
        }

        const TAIWAN_CITY_PRESETS = [
            { name: '台北市', latitude: 25.0478, longitude: 121.5319, timezone: 'Asia/Taipei', admin1: '台北', country: '台灣' },
            { name: '新北市', latitude: 25.0169, longitude: 121.4630, timezone: 'Asia/Taipei', admin1: '新北', country: '台灣' },
            { name: '桃園市', latitude: 24.9936, longitude: 121.3010, timezone: 'Asia/Taipei', admin1: '桃園', country: '台灣' },
            { name: '台中市', latitude: 24.1477, longitude: 120.6736, timezone: 'Asia/Taipei', admin1: '台中', country: '台灣' },
            { name: '台南市', latitude: 22.9908, longitude: 120.2133, timezone: 'Asia/Taipei', admin1: '台南', country: '台灣' },
            { name: '高雄市', latitude: 22.6273, longitude: 120.3014, timezone: 'Asia/Taipei', admin1: '高雄', country: '台灣' },
            { name: '基隆市', latitude: 25.1276, longitude: 121.7392, timezone: 'Asia/Taipei', admin1: '基隆', country: '台灣' },
            { name: '新竹市', latitude: 24.8138, longitude: 120.9675, timezone: 'Asia/Taipei', admin1: '新竹', country: '台灣' },
            { name: '嘉義市', latitude: 23.4801, longitude: 120.4491, timezone: 'Asia/Taipei', admin1: '嘉義', country: '台灣' },
            { name: '宜蘭縣', latitude: 24.7021, longitude: 121.7378, timezone: 'Asia/Taipei', admin1: '宜蘭', country: '台灣' },
            { name: '花蓮縣', latitude: 23.9872, longitude: 121.6015, timezone: 'Asia/Taipei', admin1: '花蓮', country: '台灣' },
            { name: '台東縣', latitude: 22.7972, longitude: 121.0714, timezone: 'Asia/Taipei', admin1: '台東', country: '台灣' },
            { name: '屏東縣', latitude: 22.5519, longitude: 120.5487, timezone: 'Asia/Taipei', admin1: '屏東', country: '台灣' },
            { name: '南投縣', latitude: 23.9609, longitude: 120.9718, timezone: 'Asia/Taipei', admin1: '南投', country: '台灣' },
            { name: '彰化縣', latitude: 24.0518, longitude: 120.5161, timezone: 'Asia/Taipei', admin1: '彰化', country: '台灣' },
            { name: '雲林縣', latitude: 23.7092, longitude: 120.4313, timezone: 'Asia/Taipei', admin1: '雲林', country: '台灣' },
            { name: '苗栗縣', latitude: 24.5602, longitude: 120.8214, timezone: 'Asia/Taipei', admin1: '苗栗', country: '台灣' },
            { name: '澎湖縣', latitude: 23.5711, longitude: 119.5793, timezone: 'Asia/Taipei', admin1: '澎湖', country: '台灣' },
            { name: '金門縣', latitude: 24.4368, longitude: 118.3186, timezone: 'Asia/Taipei', admin1: '金門', country: '台灣' },
            { name: '連江縣', latitude: 26.1605, longitude: 119.9514, timezone: 'Asia/Taipei', admin1: '連江', country: '台灣' }
        ];

        function isTaiwanGeoResult(r) {
            const code = String(r?.country_code || '').toUpperCase();
            const country = String(r?.country || '');
            if (code === 'TW') return true;
            return /台灣|臺灣|Taiwan/i.test(country);
        }

        function showTaiwanCityPresets(filter = '') {
            const hits = document.getElementById('weather-search-hits');
            if (!hits) return;
            const q = String(filter || '').trim().toLowerCase();
            const list = TAIWAN_CITY_PRESETS.filter(r => !q || r.name.toLowerCase().includes(q) || String(r.admin1 || '').toLowerCase().includes(q));
            window.__weatherHits = list;
            hits.innerHTML = list.map((r, i) => {
                const label = [r.name, r.admin1, '台灣'].filter(Boolean).join(' · ');
                return `<button type="button" onclick="pickWeatherLoc(${i})">${escapeHtml(r.name)}<small>${escapeHtml(label)}</small></button>`;
            }).join('') || `<div class="loading" style="padding:8px;">找不到台灣地區</div>`;
        }

        async function runWeatherSearch() {
            const q = document.getElementById('weather-search-input')?.value.trim() || '';
            const hits = document.getElementById('weather-search-hits');
            if (!hits) return;
            if (q.length < 1) {
                showTaiwanCityPresets();
                return;
            }
            // 先本地台灣縣市快找
            const local = TAIWAN_CITY_PRESETS.filter(r =>
                r.name.includes(q) || String(r.admin1 || '').includes(q)
            );
            if (local.length) {
                window.__weatherHits = local;
                hits.innerHTML = local.map((r, i) => {
                    const label = [r.name, r.admin1, '台灣'].filter(Boolean).join(' · ');
                    return `<button type="button" onclick="pickWeatherLoc(${i})">${escapeHtml(r.name)}<small>${escapeHtml(label)}</small></button>`;
                }).join('');
            } else {
                hits.innerHTML = `<div class="loading" style="padding:8px;">搜尋中…</div>`;
            }
            const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=20&language=zh&countryCode=TW&format=json`;
            const res = await window.api.fetchWeather(url);
            let results = res?.success ? (res.data?.results || []) : [];
            results = results.filter(isTaiwanGeoResult);
            // 若 TW 過濾太嚴，退回全部再筛台灣
            if (!results.length && res?.success) {
                const url2 = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=20&language=zh&format=json`;
                const res2 = await window.api.fetchWeather(url2);
                results = (res2?.success ? (res2.data?.results || []) : []).filter(isTaiwanGeoResult);
            }
            if (!results.length) {
                if (!local.length) hits.innerHTML = `<div class="loading" style="padding:8px;">找不到台灣地區</div>`;
                return;
            }
            // 與本地結果合併去重
            const merged = [...local];
            for (const r of results) {
                if (merged.some(x => Math.abs(x.latitude - r.latitude) < 0.05 && Math.abs(x.longitude - r.longitude) < 0.05)) continue;
                merged.push({
                    name: r.name,
                    latitude: r.latitude,
                    longitude: r.longitude,
                    timezone: r.timezone || 'Asia/Taipei',
                    admin1: r.admin1 || '',
                    country: '台灣'
                });
            }
            window.__weatherHits = merged;
            hits.innerHTML = merged.map((r, i) => {
                const label = [r.name, r.admin1, '台灣'].filter(Boolean).join(' · ');
                return `<button type="button" onclick="pickWeatherLoc(${i})">${escapeHtml(r.name)}<small>${escapeHtml(label)}</small></button>`;
            }).join('');
        }

        async function pickWeatherLoc(index) {
            const r = window.__weatherHits?.[index];
            if (!r) return;
            saveWeatherLoc({
                name: r.name,
                latitude: r.latitude,
                longitude: r.longitude,
                timezone: r.timezone || 'Asia/Taipei'
            });
            closeWeatherSearch();
            await loadWeatherForLoc();
        }


        // ========== 【MODULE: weather-focus】天氣／時鐘／Focus（header chrome） ==========
        function initWeatherAndClock() {
            loadWeatherLoc();
            loadWeatherForLoc();
            renderFocusBtn();
            updateLocalClock();
            if (clockTimer) clearInterval(clockTimer);
            clockTimer = setInterval(updateLocalClock, 1000);
            document.addEventListener('click', (e) => {
                if (!e.target.closest('#weather-widget')) {
                    closeWeatherSearch();
                    closeBugReportPanel();
                }
            });
        }

        let bugReportTab = 'new';
        let bugReportBusy = false;
        let bugReportImages = []; // { id, name, mimeType, dataBase64, previewUrl }

        function closeBugReportPanel() {
            document.getElementById('bug-report-panel')?.classList.remove('open');
        }


        // ========== 【MODULE: bug-report】Bug／優化回報面板 ==========
        function toggleBugReportPanel(event) {
            event?.stopPropagation?.();
            closeWeatherSearch();
            const panel = document.getElementById('bug-report-panel');
            if (!panel) return;
            const open = panel.classList.toggle('open');
            if (open) {
                switchBugReportTab(bugReportTab || 'new');
                refreshBugReportBadge();
            }
        }

        function renderBugImageThumbs() {
            const box = document.getElementById('bug-image-thumbs');
            if (!box) return;
            if (!bugReportImages.length) {
                box.innerHTML = '';
                return;
            }
            box.innerHTML = bugReportImages.map((img, i) => `
                <div class="bug-image-thumb">
                    <img src="${img.previewUrl}" alt="截圖${i + 1}">
                    <button type="button" title="移除" onclick="removeBugReportImage(${i})">×</button>
                </div>
            `).join('');
        }

        function removeBugReportImage(index) {
            const img = bugReportImages[index];
            if (img?.previewUrl) URL.revokeObjectURL(img.previewUrl);
            bugReportImages.splice(index, 1);
            renderBugImageThumbs();
        }

        function clearBugReportImages() {
            bugReportImages.forEach(img => {
                if (img?.previewUrl) URL.revokeObjectURL(img.previewUrl);
            });
            bugReportImages = [];
            renderBugImageThumbs();
        }

        async function addBugReportImageFile(file) {
            if (!file || !String(file.type || '').startsWith('image/')) return;
            if (bugReportImages.length >= 3) {
                const hint = document.getElementById('bug-report-hint');
                if (hint) hint.textContent = '最多可貼上 3 張圖片';
                return;
            }
            const dataBase64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const s = String(reader.result || '');
                    const b64 = s.includes(',') ? s.split(',')[1] : s;
                    resolve(b64 || '');
                };
                reader.onerror = () => reject(new Error('讀取圖片失敗'));
                reader.readAsDataURL(file);
            });
            if (!dataBase64) return;
            bugReportImages.push({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                name: file.name || `paste-${Date.now()}.png`,
                mimeType: file.type || 'image/png',
                dataBase64,
                previewUrl: URL.createObjectURL(file)
            });
            renderBugImageThumbs();
        }

        function onBugReportPaste(event) {
            const items = [...(event.clipboardData?.items || [])];
            const imageItems = items.filter(it => it.kind === 'file' && String(it.type || '').startsWith('image/'));
            if (!imageItems.length) return;
            event.preventDefault();
            imageItems.forEach(it => {
                const file = it.getAsFile();
                if (file) addBugReportImageFile(file);
            });
        }

        function bindBugReportPaste() {
            const text = document.getElementById('bug-report-text');
            const zone = document.getElementById('bug-image-zone');
            text?.addEventListener('paste', onBugReportPaste);
            zone?.addEventListener('paste', onBugReportPaste);
            zone?.addEventListener('click', () => text?.focus());
        }

        function switchBugReportTab(tab) {
            bugReportTab = tab === 'list' ? 'list' : 'new';
            document.getElementById('bug-tab-new')?.classList.toggle('active', bugReportTab === 'new');
            document.getElementById('bug-tab-list')?.classList.toggle('active', bugReportTab === 'list');
            const body = document.getElementById('bug-report-body');
            if (!body) return;
            if (bugReportTab === 'new') {
                clearBugReportImages();
                const featureOpts = (window.__bugReportFeatures || []).map(f =>
                    `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`
                ).join('');
                body.innerHTML = `
                    <div style="font-size:0.85em;color:var(--text-sub);margin-bottom:8px;">送出後可在「查看回報」追蹤處理進度。</div>
                    <div>
                        <label class="bug-cat"><input type="radio" name="bug-category" value="Bug" checked onchange="onBugCategoryChange()"> Bug</label>
                        <label class="bug-cat"><input type="radio" name="bug-category" value="優化" onchange="onBugCategoryChange()"> 優化</label>
                    </div>
                    <div id="bug-feature-wrap" style="margin-top:8px;">
                        <label style="display:block;font-size:0.82em;color:var(--text-sub);margin-bottom:4px;">回報功能</label>
                        <select id="bug-feature-select" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--item-border);background:var(--bg-color);color:var(--text-main);font:inherit;">
                            <option value="">請選擇功能…</option>
                            ${featureOpts}
                        </select>
                    </div>
                    <textarea id="bug-report-text" placeholder="請描述問題或想改善的地方…（可 Ctrl+V 貼上截圖）" style="margin-top:8px;"></textarea>
                    <div class="bug-image-zone" id="bug-image-zone" tabindex="0">
                        <div class="bug-image-hint">可在此或上方文字框按 Ctrl+V 貼上截圖（最多 3 張）</div>
                        <div class="bug-image-thumbs" id="bug-image-thumbs"></div>
                    </div>
                    <div class="bug-report-actions">
                        <button type="button" class="btn-primary" id="bug-submit-btn" onclick="submitBugReport()">送出</button>
                    </div>
                    <div id="bug-report-hint" style="margin-top:8px;font-size:0.8em;color:var(--text-sub);"></div>`;
                onBugCategoryChange();
                bindBugReportPaste();
                window.api.bugReportFeatures?.().then((res) => {
                    if (res?.success && Array.isArray(res.features)) {
                        window.__bugReportFeatures = res.features;
                        const sel = document.getElementById('bug-feature-select');
                        if (sel && res.features.length) {
                            const cur = sel.value;
                            sel.innerHTML = `<option value="">請選擇功能…</option>`
                                + res.features.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
                            if (cur && res.features.includes(cur)) sel.value = cur;
                        }
                    }
                }).catch(() => {});
            } else {
                body.innerHTML = `<div class="loading" style="padding:12px;">讀取回報中…</div>`;
                loadBugReportList();
            }
        }

        function onBugCategoryChange() {
            const cat = document.querySelector('input[name="bug-category"]:checked')?.value || 'Bug';
            const wrap = document.getElementById('bug-feature-wrap');
            const text = document.getElementById('bug-report-text');
            if (wrap) wrap.style.display = cat === 'Bug' ? '' : 'none';
            if (text) {
                text.placeholder = cat === 'Bug'
                    ? '請描述發生什麼問題…'
                    : '請描述想改善的地方…';
            }
        }

        async function submitBugReport() {
            if (bugReportBusy) return;
            const category = document.querySelector('input[name="bug-category"]:checked')?.value || '';
            const feature = document.getElementById('bug-feature-select')?.value.trim() || '';
            const message = document.getElementById('bug-report-text')?.value.trim() || '';
            const hint = document.getElementById('bug-report-hint');
            const btn = document.getElementById('bug-submit-btn');
            if (category === 'Bug' && !feature) {
                if (hint) hint.textContent = '請先選擇要回報的功能';
                return;
            }
            if (!message && !bugReportImages.length) {
                if (hint) hint.textContent = '請輸入內容或貼上截圖';
                return;
            }
            bugReportBusy = true;
            if (btn) { btn.disabled = true; btn.textContent = '送出中…'; }
            if (hint) hint.textContent = bugReportImages.length ? '上傳截圖並送出…' : '';
            const res = await window.api.bugReportSubmit({
                category,
                feature,
                message,
                images: bugReportImages.map(img => ({
                    name: img.name,
                    mimeType: img.mimeType,
                    dataBase64: img.dataBase64
                }))
            });
            bugReportBusy = false;
            if (btn) { btn.disabled = false; btn.textContent = '送出'; }
            if (!res?.success) {
                if (res?.authRevoked || res?.needsReconnect) {
                    await reconnectGoogleSession();
                } else if (res?.featureScopeMissing || res?.needsAuth) {
                    const go = confirm(`${res.error || '需要補充 Google 授權'}\n\n要補充授權嗎？`);
                    if (go) await authorizeFeature('sheets');
                } else if (res?.needsApi) {
                    const kind = res.needsDriveApi ? 'drive' : 'sheets';
                    const go = confirm(`${res.error || '需要啟用 Google API'}\n\n要開啟啟用頁嗎？`);
                    if (go) window.api.sheetsOpenSetup?.(kind === 'drive' ? { kind: 'drive' } : { kind: 'sheets' });
                } else {
                    alert(res?.error || '送出失敗');
                }
                if (hint) hint.textContent = res?.error || '送出失敗';
                return;
            }
            if (hint) hint.textContent = '已送出，謝謝回報！';
            const textEl = document.getElementById('bug-report-text');
            if (textEl) textEl.value = '';
            const sel = document.getElementById('bug-feature-select');
            if (sel) sel.value = '';
            clearBugReportImages();
            refreshBugReportBadge();
        }

        async function loadBugReportList() {
            const body = document.getElementById('bug-report-body');
            if (!body) return;
            const res = await window.api.bugReportList();
            if (!res?.success) {
                body.innerHTML = `<div class="loading" style="padding:12px;text-align:left;">${escapeHtml(res?.error || '讀取失敗')}<br><br>
                    <button class="btn-primary" onclick="loadBugReportList()">重試</button>
                </div>`;
                return;
            }
            updateBugReportBadge(res.pending || 0);
            const items = res.items || [];
            const canOpenSheet = !!(res.canOpenSheet || (appIsDev && res.sheetUrl));
            const sheetBar = canOpenSheet
                ? `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;font-size:0.8em;color:var(--text-sub);">
                        <span>我的回報 · 待處理 ${res.pending || 0} 則</span>
                        <button type="button" class="btn-ghost" onclick="openBugReportSheet()">開啟 Google Sheet</button>
                   </div>`
                : `<div style="margin-bottom:8px;font-size:0.8em;color:var(--text-sub);">待處理 ${res.pending || 0} 則</div>`;
            if (!items.length) {
                body.innerHTML = `${canOpenSheet ? sheetBar : ''}<div class="loading" style="padding:12px;">尚無你的回報</div>`;
                return;
            }
            body.innerHTML = `
                ${sheetBar}
                ${items.map(item => {
                    const tagClass = item.category === '優化' ? 'opt' : 'bug';
                    const done = item.status === '已處理';
                    const feature = item.feature ? `<span class="bug-tag" style="opacity:.85;">${escapeHtml(item.feature)}</span>` : '';
                    const reply = item.reply
                        ? `<div class="bug-msg" style="margin-top:8px;border-left:3px solid var(--accent-color);padding-left:8px;"><strong>回覆</strong><br>${escapeHtml(item.reply)}</div>`
                        : `<div style="margin-top:6px;font-size:0.78em;color:var(--text-sub);">尚無回覆</div>`;
                    const imgs = (item.images || []).filter(Boolean);
                    const imgHtml = imgs.length
                        ? `<div class="bug-item-images">${imgs.map((u, i) =>
                            `<a href="#" title="開啟原圖" onclick="event.preventDefault(); window.api.openExternal('${String(u).replace(/'/g, "\\'")}');"><img src="${escapeHtml(u)}" alt="截圖${i + 1}"></a>`
                          ).join('')}</div>`
                        : '';
                    return `<div class="bug-item ${done ? 'done' : ''}">
                        <div class="bug-item-top">
                            <span>
                                <span class="bug-tag ${tagClass}">${escapeHtml(item.category)}</span>
                                ${feature}
                                ${escapeHtml(item.status || '待處理')}
                            </span>
                            <span>${escapeHtml(item.time || '')}</span>
                        </div>
                        <div class="bug-msg">${escapeHtml(item.message)}</div>
                        ${imgHtml}
                        ${reply}
                        <div class="bug-item-top" style="margin-top:6px;margin-bottom:0;">
                            <span></span>
                            <span>${escapeHtml(item.version || '')}</span>
                        </div>
                    </div>`;
                }).join('')}`;
        }

        async function openBugReportSheet() {
            if (!appIsDev) return;
            const res = await window.api.bugReportOpenSheet?.();
            if (!res?.success) alert(res?.error || '無法開啟試算表');
        }

        function updateBugReportBadge(n) {
            const badge = document.getElementById('bug-report-badge');
            if (!badge) return;
            const count = Number(n) || 0;
            badge.textContent = String(count);
            badge.classList.toggle('show', count > 0);
        }

        async function refreshBugReportBadge() {
            try {
                const res = await window.api.bugReportList();
                if (res?.success) updateBugReportBadge(res.pending || 0);
            } catch (_) {}
        }

        // 🌟 正確：移到全域空間，讓 HTML onclick 找得到

        // ========== 【MODULE: Authorization】登入／功能授權閘道 ==========

        async function loginGoogle() {
            const btn = document.getElementById('btn-login-google') || document.querySelector('.auth-container .btn-primary');
            if (btn) btn.textContent = '授權中…請看瀏覽器';
            try {
                const res = await window.api.authGoogleFeatures?.({
                    types: ALL_GOOGLE_FEATURE_TYPES
                });
                if (res?.success) {
                    showWorkspace();
                } else {
                    alert(res?.error || '授權失敗');
                    if (btn) btn.textContent = '使用 Google 帳號登入並授權';
                    try {
                        const probeRes = await window.api.credentialProbe?.();
                        paintCredentialProbe(probeRes?.credentialProbe, { needsAuth: true });
                    } catch (_) {}
                }
            } catch (err) {
                alert('授權出錯: ' + err.message);
                if (btn) btn.textContent = '使用 Google 帳號登入並授權';
            }
        }

        async function reconnectGoogleFromLogin() {
            await reconnectGoogleSession();
        }

        function mosaicFeatureTypes() {
            return [...new Set(mosaicItems.map(i => i.type).filter(t => WIDGET_CATALOG[t]))];
        }

        function paintFeatureAuthGate(el, type, label) {
            if (!el) return;
            const name = label || type;
            el.innerHTML = `
                <div class="loading" style="text-align:left;line-height:1.6;padding:12px;">
                    <div style="font-weight:650;margin-bottom:6px;">「${escapeHtml(name)}」需要額外 Google 權限</div>
                    <div style="opacity:.8;margin-bottom:12px;">帳號已登入時，只會補充此功能缺少的權限，不會清除既有授權。</div>
                    <button class="btn-primary" onclick="event.stopPropagation(); authorizeFeature('${type}')">補充授權</button>
                </div>`;
        }

        async function ensureFeatureAuthorized(type) {
            try {
                const res = await window.api.featureAuthStatus?.(type);
                if (res?.authorized) return true;
                return false;
            } catch (_) {
                return false;
            }
        }

        async function authorizeFeature(type) {
            const labelMap = {
                calendar: '預定行程', tasks: '待辦事項', gmail: '未讀郵件',
                gchat: 'Little Reply', sheets: '9527', sitesVisits: '網站瀏覽紀錄', chat: '詢問機器人'
            };
            const label = labelMap[type] || type;
            try {
                const status = await window.api.featureAuthStatus?.(type);
                if (status?.authorized) return true;
                if (status?.needsReconnect || status?.authStatus === 'AUTH_REVOKED') {
                    return !!(await reconnectGoogleSession());
                }
                const res = await window.api.authGoogleFeatures?.({ types: [type] });
                if (!res?.success) {
                    if (res?.needsApi && type === 'gchat') await openGchatApiSetup();
                    if (res?.needsApi && type === 'sheets') openSheetsApiSetup();
                    alert(res?.error || `授權「${label}」失敗`);
                    return false;
                }
                await refreshWidget(type);
                return true;
            } catch (err) {
                alert(err?.message || `授權「${label}」失敗`);
                return false;
            }
        }

        function refreshAll() {
            if (document.getElementById('task-list')) loadTasks();
            if (document.getElementById('cal-list')) loadCalendar();
            if (document.getElementById('gmail-list')) loadGmail();
            if (document.getElementById('gchat-list')) loadGchat();
            if (document.getElementById('sheets-list')) loadSheets();
            if (document.getElementById('sites-visits-list')) loadSitesVisits();
        }

        async function showWorkspace() {
            document.getElementById('auth-container').style.display = 'none';
            document.getElementById('dashboard-shell').style.display = 'flex';
            await initDistFeatures();
            applySettingsMode();
            restoreMosaic();
            refreshAll();
            syncGchatAlertPrefAndPoll();
            refreshBugReportBadge();
            try {
                const sess = await window.api.ensureSession();
                updateSessionHint(sess);
            } catch (_) {}
            window.api.onGchatOpenMessage?.((name) => {
                if (name) openGchatBubble(name);
            });
            const applyGchatCacheSnapshot = (res) => {
                if (!res?.success) return;
                if (res?.quotaBlocked) {
                    gchatApiQuotaBlockedUntil = Number(res.quotaBlockedUntil) || (Date.now() + 30 * 60 * 1000);
                }
            applyGchatIdentityFromRes(res);
            updateGchatHint(res);
            if (Array.isArray(res.messages)) setGchatListMessages(res.messages);
            renderGchatPinnedBlock();
            const list = document.getElementById('gchat-list');
                if (list) {
                    paintGchatList(res.messages || []);
                }
                refreshOpenGchatThread();
            };
            // [Important] Cache Push 只訂閱 gchat-cache-changed（不再用 gchat-list-updated）
            window.api.onGchatCacheChanged?.(applyGchatCacheSnapshot);
            window.api.onGchatThreadPing?.(() => {
                refreshOpenGchatThread();
            });
            window.api.onFeatureSyncTick?.((type) => {
                if (type === 'calendar' && document.getElementById('cal-list')) loadCalendar();
                if (type === 'tasks' && document.getElementById('task-list')) loadTasks();
                if (type === 'sheets' && document.getElementById('sheets-list')) loadSheets();
                if (type === 'sitesVisits' && document.getElementById('sites-visits-list')) loadSitesVisits();
                if (type === 'chat' && document.getElementById('chat-log')) mountChat();
            });
            window.api.onFeaturesSynced?.(({ types } = {}) => {
                for (const t of types || []) refreshWidget(t).catch?.(() => {});
            });
        }

        const MOSAIC_COLS = 12;
        const MOSAIC_ROW = 72;
        const MOSAIC_GAP = 14;
        const MOSAIC_KEY = 'mosaic-layout-v1';

        // =====================================================================

        // ========== 【MODULE: Mosaic】加入功能／拼貼引擎／Partial 掛載 ==========
        // [MODULE: Mosaic / WIDGET_CATALOG]
        // body 不內嵌於此；「加入功能」時載入 renderer/features/<type>/view.html
        // =====================================================================
        const WIDGET_CATALOG = {
            calendar: {
                title: '📅 預定行程',
                minW: 3, minH: 4, w: 4, h: 7,
                partial: true,
                extra: '<button class="add-btn" onclick="event.stopPropagation(); showCreateEventModal()">+</button>',
                mount: () => loadCalendar()
            },
            tasks: {
                title: '☑️ 待辦事項',
                minW: 3, minH: 4, w: 4, h: 7,
                partial: true,
                extra: '',
                mount: () => loadTasks()
            },
            gmail: {
                title: '📧 未讀郵件',
                minW: 3, minH: 4, w: 4, h: 7,
                partial: true,
                extra: '<span class="sync-hint" id="mail-sync-hint"></span>',
                mount: () => loadGmail()
            },
            gchat: {
                title: '💬 Little Reply',
                addLabel: '加入 Little Reply',
                minW: 3, minH: 4, w: 4, h: 7,
                partial: true,
                extra: '<span class="sync-hint" id="gchat-sync-hint"></span>',
                mount: () => loadGchat()
            },
            sheets: {
                title: '📋 9527',
                addLabel: '加入9527',
                minW: 3, minH: 4, w: 4, h: 8,
                partial: true,
                extra: '<span class="sync-hint" id="sheets-sync-hint"></span>',
                mount: () => loadSheets({ startPoll: true })
            },
            sitesVisits: {
                title: '🌐 網站瀏覽紀錄',
                minW: 4, minH: 4, w: 5, h: 7,
                partial: true,
                extra: `<span class="sync-hint" id="sites-visits-sync-hint"></span>
                    <button class="link-btn" onclick="event.stopPropagation(); exportSitesVisitsExcel()">輸出 Excel</button>`,
                mount: () => loadSitesVisits({ startPoll: true })
            },
            chat: {
                title: '🤖 詢問機器人',
                minW: 4, minH: 5, w: 5, h: 8,
                partial: true,
                extra: `<button class="link-btn" onclick="event.stopPropagation(); showChatView('kb')">資料庫</button>
                    <button class="link-btn" onclick="event.stopPropagation(); showChatView('settings')">設定</button>`,
                mount: () => mountChat()
            }
        };

        let mosaicItems = [];
        let mosaicDrag = null;

        // [Important] 預設當正式包（全關），等 getDistFeatures 回傳後再決定
        // 正式包：只有 checkbox 打勾（dist-features === true）才可加入／顯示
        // [Development Only] npm start：可測全部；左側勾選控制正式版是否提供
        let appIsDev = false;
        let distFeatureFlags = Object.fromEntries(
            Object.keys(WIDGET_CATALOG).map(k => [k, false])
        );

        async function initDistFeatures() {
            try {
                const res = await window.api.getDistFeatures?.();
                if (res && res.success !== false) {
                    appIsDev = !!res.dev && !res.packaged;
                    if (res.widgets && typeof res.widgets === 'object') {
                        distFeatureFlags = { ...distFeatureFlags, ...res.widgets };
                    }
                } else if (res?.packaged) {
                    appIsDev = false;
                }
            } catch (_) {
                appIsDev = false;
            }
        }

        function isDistFeatureEnabled(type) {
            // [Important] 必須明確 true；缺值／false 都不進正式功能
            return distFeatureFlags[type] === true;
        }

        function isWidgetAvailable(type) {
            if (!WIDGET_CATALOG[type]) return false;
            // 開發：全部可加入（未勾顯示「開發中」）；正式包：僅打勾功能
            if (appIsDev) return true;
            return isDistFeatureEnabled(type);
        }

        function pruneUnavailableMosaicItems() {
            const before = mosaicItems.length;
            mosaicItems = mosaicItems.filter(i => isWidgetAvailable(i.type));
            if (mosaicItems.length !== before) saveMosaic();
        }

        function catalogEntriesForMenu() {
            return Object.entries(WIDGET_CATALOG).filter(([type]) => isWidgetAvailable(type));
        }

        function toggleAddMenu() {
            const menu = document.getElementById('add-menu');
            const open = !menu.classList.contains('open');
            renderAddMenu();
            menu.classList.toggle('open', open);
        }

        function renderAddMenu() {
            const added = new Set(mosaicItems.map(i => i.type));
            const entries = catalogEntriesForMenu();
            const menu = document.getElementById('add-menu');
            if (!entries.length) {
                menu.innerHTML = '<div class="add-menu-item" style="cursor:default;">尚無可用功能</div>';
                return;
            }
            const hint = appIsDev
                ? `<div class="add-menu-hint">左側打勾＝正式安裝包會提供；未勾僅開發可測，正式使用者看不到。</div>`
                : '';
            menu.innerHTML = hint + entries.map(([type, def]) => {
                const label = def.addLabel || def.title;
                const forDist = isDistFeatureEnabled(type);
                const check = appIsDev
                    ? `<label class="add-menu-dist-check" title="正式版是否提供此功能" onclick="event.stopPropagation()">
                        <input type="checkbox" ${forDist ? 'checked' : ''}
                            onchange="onDistFeatureCheck(event, '${type}')">
                       </label>`
                    : '';
                return `
                <div class="add-menu-row">
                    ${check}
                    <button type="button" class="add-menu-item" ${added.has(type) ? 'disabled' : ''} onclick="addWidget('${type}')">
                        ${label}${added.has(type) ? '（已加入）' : ''}${appIsDev && !forDist ? ' · 開發中' : ''}
                    </button>
                </div>`;
            }).join('');
        }

        async function onDistFeatureCheck(event, type) {
            event?.stopPropagation?.();
            const enabled = !!event?.target?.checked;
            distFeatureFlags[type] = enabled;
            try {
                const res = await window.api.setDistFeature?.({ type, enabled });
                if (!res?.success) {
                    distFeatureFlags[type] = !enabled;
                    if (event?.target) event.target.checked = !enabled;
                    alert(res?.error || '無法儲存打包開關');
                    return;
                }
                if (res.widgets) distFeatureFlags = { ...distFeatureFlags, ...res.widgets };
            } catch (err) {
                distFeatureFlags[type] = !enabled;
                if (event?.target) event.target.checked = !enabled;
                alert(err?.message || '無法儲存打包開關');
            }
            renderAddMenu();
        }

        function addWidget(type) {
            if (!isWidgetAvailable(type)) return;
            if (mosaicItems.some(i => i.type === type)) return;
            const def = WIDGET_CATALOG[type];
            const spot = findMosaicPlace(def.w, def.h);
            mosaicItems.push({ type, x: spot.x, y: spot.y, w: def.w, h: def.h });
            document.getElementById('add-menu').classList.remove('open');
            renderMosaic({ mountType: type });
            saveMosaic();
            ensureSessionForWidget().then(() => refreshWidget(type));
        }

        function removeWidget(type) {
            mosaicItems = mosaicItems.filter(i => i.type !== type);
            if (type === 'sheets') stopSheetsPoll();
            if (type === 'sitesVisits') stopSitesVisitsPoll();
            if (type === 'gchat') stopGchatPoll();
            compactMosaic();
            renderMosaic();
            saveMosaic();
        }

        function findMosaicPlace(w, h) {
            for (let y = 0; y < 48; y++) {
                for (let x = 0; x <= MOSAIC_COLS - w; x++) {
                    const cand = { x, y, w, h };
                    if (!mosaicItems.some(it => mosaicOverlap(cand, it))) return cand;
                }
            }
            const maxY = mosaicItems.reduce((m, i) => Math.max(m, i.y + i.h), 0);
            return { x: 0, y: maxY, w, h };
        }

        function mosaicOverlap(a, b) {
            return a !== b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        }

        function compactMosaic() {
            mosaicItems.sort((a, b) => a.y - b.y || a.x - b.x);
            mosaicItems.forEach(item => {
                while (item.y > 0) {
                    item.y -= 1;
                    if (mosaicItems.some(other => other !== item && mosaicOverlap(item, other))) {
                        item.y += 1;
                        break;
                    }
                }
            });
        }

        function resolveMosaic(moved) {
            let guard = 0;
            let changed = true;
            while (changed && guard++ < 80) {
                changed = false;
                mosaicItems.forEach(other => {
                    if (other === moved) return;
                    if (mosaicOverlap(moved, other)) {
                        other.y = moved.y + moved.h;
                        changed = true;
                    }
                });
            }
        }

        function tileMetrics() {
            const board = document.getElementById('mosaic');
            const width = Math.max(board.clientWidth, 320);
            const scale = getUiScale();
            const gap = MOSAIC_GAP * scale;
            const row = MOSAIC_ROW * scale;
            const colW = (width - gap * (MOSAIC_COLS - 1)) / MOSAIC_COLS;
            return { colW, stepX: colW + gap, stepY: row + gap, gap, row };
        }

        function applyTileGeometry() {
            const board = document.getElementById('mosaic');
            if (!board) return;
            const { stepX, stepY, colW, gap, row } = tileMetrics();
            mosaicItems.forEach(item => {
                const el = document.getElementById('tile-' + item.type);
                if (!el) return;
                el.style.left = (item.x * stepX) + 'px';
                el.style.top = (item.y * stepY) + 'px';
                el.style.width = (item.w * colW + (item.w - 1) * gap) + 'px';
                el.style.height = (item.h * row + (item.h - 1) * gap) + 'px';
            });
            const maxY = mosaicItems.reduce((m, i) => Math.max(m, i.y + i.h), 0);
            board.style.minHeight = (maxY * stepY + 8) + 'px';
        }

        async function renderMosaic({ mountType } = {}) {
            const board = document.getElementById('mosaic');
            if (!mosaicItems.length) {
                board.innerHTML = `<div class="mosaic-empty"><div>工作台還是空的</div><div>用左上角「加入功能」把日曆、待辦、郵件拼進來</div></div>`;
                return;
            }
            const existing = new Set([...board.querySelectorAll('.tile')].map(el => el.dataset.type));
            if (board.querySelector('.mosaic-empty')) board.innerHTML = '';

            // [Important] 並行載入尚未掛上的 partial view
            const needTypes = mosaicItems
                .map(i => i.type)
                .filter(type => !document.getElementById('tile-' + type) && WIDGET_CATALOG[type]);
            const bodies = {};
            await Promise.all(needTypes.map(async (type) => {
                try {
                    bodies[type] = await window.PartialViews.load(type);
                } catch (err) {
                    console.error(err);
                    bodies[type] = `<div class="card-body"><div class="loading">無法載入畫面：${escapeHtml(err.message || String(err))}</div></div>`;
                }
            }));

            for (const item of mosaicItems) {
                if (document.getElementById('tile-' + item.type)) continue;
                const def = WIDGET_CATALOG[item.type];
                if (!def) continue;
                const tile = document.createElement('div');
                tile.className = 'tile';
                tile.id = 'tile-' + item.type;
                tile.dataset.type = item.type;
                const bodyHtml = bodies[item.type] || '';
                tile.innerHTML = `
                    <div class="tile-header" onpointerdown="startMosaicDrag(event, '${item.type}', 'move')">
                        <span class="tile-title" ondblclick="event.stopPropagation(); refreshWidget('${item.type}')" title="雙擊重新連線">${def.title}</span>
                        ${def.extra || ''}
                        <button class="tile-remove" title="移除此功能" onclick="event.stopPropagation(); removeWidget('${item.type}')">✕</button>
                    </div>
                    ${bodyHtml}
                    <div class="tile-resize" onpointerdown="startMosaicDrag(event, '${item.type}', 'resize')"></div>
                `;
                board.appendChild(tile);
                if (mountType === item.type || !existing.has(item.type)) def.mount?.();
            }

            [...board.querySelectorAll('.tile')].forEach(el => {
                if (!mosaicItems.some(i => i.type === el.dataset.type)) el.remove();
            });
            applyTileGeometry();
        }

        function startMosaicDrag(event, type, mode) {
            if (event.button !== 0) return;
            if (mode === 'move' && event.target.closest('button, input, .sync-hint')) return;
            event.preventDefault();
            const item = mosaicItems.find(i => i.type === type);
            const tile = document.getElementById('tile-' + type);
            tile?.classList.add('is-dragging');
            mosaicDrag = {
                type, mode,
                startX: event.clientX,
                startY: event.clientY,
                orig: { x: item.x, y: item.y, w: item.w, h: item.h }
            };
            document.addEventListener('pointermove', onMosaicMove);
            document.addEventListener('pointerup', endMosaicDrag);
        }

        function onMosaicMove(event) {
            if (!mosaicDrag) return;
            const item = mosaicItems.find(i => i.type === mosaicDrag.type);
            const def = WIDGET_CATALOG[item.type];
            const { stepX, stepY } = tileMetrics();
            const dx = event.clientX - mosaicDrag.startX;
            const dy = event.clientY - mosaicDrag.startY;
            if (mosaicDrag.mode === 'move') {
                item.x = Math.max(0, Math.min(MOSAIC_COLS - item.w, mosaicDrag.orig.x + Math.round(dx / stepX)));
                item.y = Math.max(0, mosaicDrag.orig.y + Math.round(dy / stepY));
            } else {
                item.w = Math.max(def.minW, Math.min(MOSAIC_COLS - item.x, mosaicDrag.orig.w + Math.round(dx / stepX)));
                item.h = Math.max(def.minH, mosaicDrag.orig.h + Math.round(dy / stepY));
            }
            resolveMosaic(item);
            applyTileGeometry();
        }

        function endMosaicDrag() {
            document.removeEventListener('pointermove', onMosaicMove);
            document.removeEventListener('pointerup', endMosaicDrag);
            if (mosaicDrag) {
                document.getElementById('tile-' + mosaicDrag.type)?.classList.remove('is-dragging');
            }
            mosaicDrag = null;
            compactMosaic();
            applyTileGeometry();
            saveMosaic();
        }

        function saveMosaic() {
            localStorage.setItem(MOSAIC_KEY, JSON.stringify(mosaicItems.map(({ type, x, y, w, h }) => ({ type, x, y, w, h }))));
        }

        function restoreMosaic() {
            try {
                const saved = JSON.parse(localStorage.getItem(MOSAIC_KEY) || '[]');
                mosaicItems = Array.isArray(saved) ? saved.filter(i => WIDGET_CATALOG[i?.type]) : [];
            } catch (_) {
                mosaicItems = [];
            }
            // [Important] 正式包：拿掉未打勾的開發中功能（含舊版 localStorage）
            pruneUnavailableMosaicItems();
            renderMosaic();
            if (!restoreMosaic.bound) {
                window.addEventListener('resize', applyTileGeometry);
                restoreMosaic.bound = true;
            }
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.add-menu')) {
                document.getElementById('add-menu')?.classList.remove('open');
            }
            if (!e.target.closest('.theme-picker')) {
                document.getElementById('theme-menu')?.classList.remove('open');
            }
            if (!e.target.closest('.app-settings')) {
                document.getElementById('app-settings-menu')?.classList.remove('open');
            }
        });

        function escapeHtml(str) {
            return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function toggleGroup(id) {
            document.getElementById(id)?.classList.toggle('collapsed');
        }


        // ========== 【FEATURE: tasks】待辦（邏輯待下沉 features/tasks/logic.js） ==========
        let currentTasks = {};

        function indexTasksFromTree(list) {
            for (const t of list || []) {
                currentTasks[t.id] = t;
                indexTasksFromTree(t.children);
            }
        }

        function renderTaskChildren(children) {
            if (!children?.length) return '';
            return `<div class="task-sub-list">${children.map(c => `
                <div class="task-sub-item ${c.status === 'completed' ? 'task-completed' : ''}" id="task-item-${escapeHtml(c.id)}">
                    <input type="checkbox" class="task-checkbox" ${c.status === 'completed' ? 'checked' : ''}
                        onchange="toggleTask('${escapeHtml(c.id)}')">
                    <div class="task-main">
                        <span class="task-title" title="點擊編輯子工作" onclick="startEditTask('${escapeHtml(c.id)}')">${escapeHtml(c.title || '（無標題）')}</span>
                        ${c.notes ? `<div class="task-notes-preview">${escapeHtml(c.notes)}</div>` : ''}
                    </div>
                    <button type="button" class="task-edit-btn" title="編輯子工作" onclick="startEditTask('${escapeHtml(c.id)}')">✎</button>
                </div>`).join('')}</div>`;
        }

        function renderTaskItem(t) {
            const kids = t.children || [];
            const doneKids = kids.filter(c => c.status === 'completed').length;
            return `
                <div class="list-item ${t.status === 'completed' ? 'task-completed' : ''}" id="task-item-${escapeHtml(t.id)}">
                    <div class="task-row">
                        <input type="checkbox" class="task-checkbox" ${t.status === 'completed' ? 'checked' : ''}
                            onchange="toggleTask('${escapeHtml(t.id)}')">
                        <div class="task-main">
                            <span class="task-title" title="點擊編輯" onclick="startEditTask('${escapeHtml(t.id)}')">${escapeHtml(t.title || '（無標題）')}</span>
                            ${t.notes ? `<div class="task-notes-preview">${escapeHtml(t.notes)}</div>` : ''}
                            ${kids.length ? `<div class="task-sub-count">子工作 ${doneKids}/${kids.length}</div>` : ''}
                            ${renderTaskChildren(kids)}
                        </div>
                        <button type="button" class="task-edit-btn" title="編輯" onclick="startEditTask('${escapeHtml(t.id)}')">✎</button>
                    </div>
                </div>`;
        }

        async function loadTasks() {
            const list = document.getElementById('task-list');
            if (!list) return;
            if (!(await ensureFeatureAuthorized('tasks'))) {
                paintFeatureAuthGate(list, 'tasks', '待辦事項');
                return;
            }
            const res = await window.api.getTasks();
            if (!res.success) {
                list.innerHTML = `<div class="loading">${escapeHtml(res.error || '讀取失敗')}</div>`;
                return;
            }
            currentTasks = {};
            if (res.byId && typeof res.byId === 'object') {
                currentTasks = { ...res.byId };
            } else {
                indexTasksFromTree(res.tasks || []);
            }
            list.innerHTML = (res.tasks || []).map(renderTaskItem).join('')
                || `<div class="loading">尚無待辦</div>`;
        }

        async function addTask() {
            const input = document.getElementById('new-task');
            if (!input || !input.value.trim()) return;
            const res = await window.api.addTask({ title: input.value.trim() });
            if (!res?.success) return alert(res?.error || '新增失敗');
            input.value = '';
            loadTasks();
        }

        async function toggleTask(id) {
            const t = currentTasks[id];
            if (!t) return;
            const next = t.status === 'completed' ? 'needsAction' : 'completed';
            // 只 patch 狀態，不碰 title／notes
            const res = await window.api.updateTask(id, { status: next });
            if (!res?.success) return alert(res?.error || '更新失敗');
            loadTasks();
        }

        function startEditTask(id) {
            const t = currentTasks[id];
            const item = document.getElementById(`task-item-${id}`);
            if (!t || !item || item.querySelector('.task-edit-panel')) return;
            const isSub = !!t.parent;
            const kids = t.children || [];
            const notesVal = escapeHtml(t.notes || '');
            const titleVal = escapeHtml(t.title || '').replace(/"/g, '&quot;');
            const subRows = isSub ? '' : `
                <div class="task-sub-edit-block">
                    <div class="task-sub-edit-label">子工作</div>
                    <div id="task-sub-edit-list-${escapeHtml(id)}">
                        ${kids.map(c => `
                            <div class="task-sub-edit-row" data-sub-id="${escapeHtml(c.id)}">
                                <input type="checkbox" class="task-checkbox" ${c.status === 'completed' ? 'checked' : ''}
                                    onchange="toggleTask('${escapeHtml(c.id)}')">
                                <input type="text" class="task-title-input task-sub-title-input" value="${escapeHtml(c.title || '').replace(/"/g, '&quot;')}" placeholder="子工作標題">
                            </div>`).join('')}
                    </div>
                    <div class="task-sub-add-row">
                        <input type="text" class="task-title-input" id="task-new-sub-${escapeHtml(id)}" placeholder="新增子工作…">
                        <button type="button" class="add-btn" title="新增子工作" onclick="addSubTask('${escapeHtml(id)}')">+</button>
                    </div>
                </div>`;
            item.innerHTML = `
                <div class="task-edit-panel">
                    <input type="text" class="task-title-input" id="task-edit-title-${escapeHtml(id)}" value="${titleVal}" placeholder="標題">
                    <textarea class="task-notes-input" id="task-edit-notes-${escapeHtml(id)}" placeholder="詳細資料（選填）">${notesVal}</textarea>
                    ${subRows}
                    <div class="task-edit-actions">
                        <button type="button" class="add-btn" title="儲存" onclick="saveEditTask('${escapeHtml(id)}')">儲存</button>
                        <button type="button" class="add-btn" title="取消" onclick="loadTasks()">取消</button>
                    </div>
                </div>`;
            const titleInput = document.getElementById(`task-edit-title-${id}`);
            titleInput?.focus();
            titleInput?.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    loadTasks();
                }
            });
            document.getElementById(`task-edit-notes-${id}`)?.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    loadTasks();
                }
            });
            document.getElementById(`task-new-sub-${id}`)?.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    addSubTask(id);
                }
            });
        }

        async function addSubTask(parentId) {
            const input = document.getElementById(`task-new-sub-${parentId}`);
            const title = input?.value?.trim();
            if (!title) return;
            input.disabled = true;
            const res = await window.api.addTask({ title, parent: parentId });
            if (!res?.success) {
                input.disabled = false;
                return alert(res?.error || '新增子工作失敗');
            }
            // 重新載入後維持編輯父任務
            await loadTasks();
            startEditTask(parentId);
        }

        async function saveEditTask(id) {
            const t = currentTasks[id];
            const titleEl = document.getElementById(`task-edit-title-${id}`);
            const notesEl = document.getElementById(`task-edit-notes-${id}`);
            if (!t || !titleEl || !notesEl) return;
            const title = titleEl.value.trim();
            const notes = notesEl.value;
            if (!title) return alert('標題不能空白');

            titleEl.disabled = true;
            notesEl.disabled = true;

            // 父／子任務：只送有變更的欄位；細項與標題可分開更新
            const fields = {};
            if (title !== (t.title || '')) fields.title = title;
            if (notes !== (t.notes || '')) fields.notes = notes;

            if (Object.keys(fields).length) {
                const res = await window.api.updateTask(id, fields);
                if (!res?.success) {
                    titleEl.disabled = false;
                    notesEl.disabled = false;
                    return alert(res?.error || '儲存失敗');
                }
            }

            // 父任務編輯面板內的子工作標題
            if (!t.parent) {
                const listEl = document.getElementById(`task-sub-edit-list-${id}`);
                const rows = [...(listEl?.querySelectorAll('.task-sub-edit-row') || [])];
                for (const row of rows) {
                    const subId = row.getAttribute('data-sub-id');
                    const sub = currentTasks[subId];
                    const subInput = row.querySelector('.task-sub-title-input');
                    if (!sub || !subInput) continue;
                    const subTitle = subInput.value.trim();
                    if (!subTitle) continue;
                    if (subTitle === (sub.title || '')) continue;
                    const subRes = await window.api.updateTask(subId, { title: subTitle });
                    if (!subRes?.success) {
                        titleEl.disabled = false;
                        notesEl.disabled = false;
                        return alert(subRes?.error || '子工作儲存失敗');
                    }
                }
            }

            loadTasks();
        }

        let currentEvents = [];
        let writableCalendars = [];

        // ========== 【FEATURE: calendar】日曆（邏輯待下沉 features/calendar/logic.js） ==========
        async function loadCalendar() {
            const list = document.getElementById('cal-list');
            if (!list) return;
            if (!(await ensureFeatureAuthorized('calendar'))) {
                paintFeatureAuthGate(list, 'calendar', '預定行程');
                return;
            }
            list.innerHTML = `<div class="loading">載入各日曆行程中...</div>`;
            const res = await window.api.getCalendar();
            if (!res.success) {
                list.innerHTML = `<div class="loading">${escapeHtml(res.error || '讀取失敗')}</div>`;
                return;
            }
            writableCalendars = res.calendars || [];
            currentEvents = [];
            const groups = res.groups || [];
            if (groups.length === 0) {
                list.innerHTML = `<div class="loading">目前沒有即將到來的行程</div>`;
                return;
            }
            list.innerHTML = groups.map((group, gIdx) => {
                const collapsed = group.primary ? '' : 'collapsed';
                const eventsHtml = group.events.map(e => {
                    const idx = currentEvents.length;
                    currentEvents.push(e);
                    let dateStr = ''; let timeStr = '';
                    if (e.start?.dateTime) {
                        const d = new Date(e.start.dateTime);
                        dateStr = d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' });
                        timeStr = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
                    } else if (e.start?.date) {
                        dateStr = new Date(e.start.date).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' });
                        timeStr = '全天';
                    }
                    const loc = e.location ? `<div class="event-details">📍 ${escapeHtml(e.location)}</div>` : '';
                    const meet = e.meetingUrl ? `<div class="event-details">🔗 會議連結</div>` : '';
                    return `
                    <div class="list-item" onclick="showEventModal(${idx})">
                        <div class="event-header"><span class="event-title">${escapeHtml(e.summary || '無標題')}</span><span class="event-time-badge" style="background:color-mix(in srgb, ${escapeHtml(group.color)} 22%, var(--card-bg))">${timeStr}</span></div>
                        <div class="event-details">🗓️ ${dateStr}</div>
                        ${loc}
                        ${meet}
                    </div>`;
                }).join('');
                return `
                <div class="group-block ${collapsed}" id="cal-group-${gIdx}">
                    <div class="group-header" onclick="toggleGroup('cal-group-${gIdx}')">
                        <span class="group-dot" style="background:${escapeHtml(group.color)}"></span>
                        <span class="group-title">${escapeHtml(group.name)}</span>
                        <span class="group-count">${group.events.length}</span>
                        <span class="group-chevron">▾</span>
                    </div>
                    <div class="group-items">${eventsHtml || '<div class="loading">沒有即將到來的行程</div>'}</div>
                </div>`;
            }).join('');
        }
        function showEventModal(index) {
            const e = currentEvents[index];
            const meetHtml = e.meetingUrl
                ? `<div>🔗 會議：<a href="#" onclick="event.preventDefault(); openMeetingLink(${index})">${escapeHtml(e.meetingUrl)}</a></div>`
                : '';
            setModalKind('');
            document.getElementById('modal-body').innerHTML = `
                <div class="modal-title">📅 ${escapeHtml(e.summary || '無標題')}</div>
                <div style="font-size: 1.1em; color: var(--text-sub); margin-bottom: 20px;">
                    <div>📂 日曆：${escapeHtml(e.calendarName || '')}</div>
                    ${e.location ? `<div>📍 地點：${escapeHtml(e.location)}</div>` : ''}
                    ${meetHtml}
                </div>
                <div style="flex-grow:1; white-space:pre-wrap; font-size:1.1em;">${escapeHtml(e.description || '無詳細說明')}</div>
            `;
            document.getElementById('detail-modal').style.display = 'flex';
        }

        function openMeetingLink(index) {
            const url = currentEvents[index]?.meetingUrl;
            if (url) window.api.openExternal(url);
        }

        function closeModal() {
            document.getElementById('detail-modal').style.display = 'none';
            document.querySelector('#detail-modal .modal-content')?.classList.remove('sheet-modal', 'gchat-modal');
            closeGchatLightbox();
            gchatMediaStore = {};
            currentGchatContext = null;
            gchatPendingAttachments = [];
            syncGchatViewing();
        }

        function onModalOverlayClick(event) {
            if (event.target === event.currentTarget) closeModal();
        }

        function setModalKind(kind) {
            const box = document.querySelector('#detail-modal .modal-content');
            if (!box) return;
            box.classList.remove('sheet-modal', 'gchat-modal');
            if (kind) box.classList.add(kind);
        }

        let currentSheetItems = [];
        let currentSheetFacets = { issueTypes: [], units: [] };
        let sheetsStatusFilter = 'pending';
        let sheetsTypeFilter = '';
        let sheetsUnitFilter = '';
        let sheetsTypeExpanded = false;
        let sheetsUnitExpanded = false;
        let sheetsTimer = null;

        function stopSheetsPoll() {
            if (sheetsTimer) {
                clearInterval(sheetsTimer);
                sheetsTimer = null;
            }
        }

        function setSheetsStatusFilter(filter) {
            sheetsStatusFilter = filter === 'all' ? 'all' : 'pending';
            document.querySelectorAll('#sheets-status-chips .chip').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.status === sheetsStatusFilter);
            });
            renderSheetsList();
        }

        function toggleSheetsFacet(kind) {
            if (kind === 'type') {
                sheetsTypeExpanded = !sheetsTypeExpanded;
                if (sheetsTypeExpanded) sheetsUnitExpanded = false;
            }
            if (kind === 'unit') {
                sheetsUnitExpanded = !sheetsUnitExpanded;
                if (sheetsUnitExpanded) sheetsTypeExpanded = false;
            }
            renderSheetsFacetChips();
        }

        function setSheetsTypeFilter(type) {
            sheetsTypeFilter = sheetsTypeFilter === type ? '' : (type || '');
            sheetsTypeExpanded = false;
            renderSheetsFacetChips();
            renderSheetsList();
        }

        function setSheetsUnitFilter(unit) {
            sheetsUnitFilter = sheetsUnitFilter === unit ? '' : (unit || '');
            sheetsUnitExpanded = false;
            renderSheetsFacetChips();
            renderSheetsList();
        }

        function renderSheetsFacetChips() {
            const typeRow = document.getElementById('sheets-type-row');
            const unitRow = document.getElementById('sheets-unit-row');
            const panel = document.getElementById('sheets-facet-panel');
            const types = currentSheetFacets.issueTypes || [];
            const units = currentSheetFacets.units || [];

            if (typeRow) {
                if (!types.length) {
                    typeRow.innerHTML = '';
                } else {
                    const label = sheetsTypeFilter || '全部';
                    const arrow = sheetsTypeExpanded ? '▴' : '▾';
                    typeRow.innerHTML = `<button class="chip ${sheetsTypeFilter || sheetsTypeExpanded ? 'active' : ''} sheets-facet-toggle" onclick="event.stopPropagation(); toggleSheetsFacet('type')">問題類型 · ${escapeHtml(label)} ${arrow}</button>`;
                }
            }

            if (unitRow) {
                if (!units.length) {
                    unitRow.innerHTML = '';
                } else {
                    const label = sheetsUnitFilter || '全部';
                    const arrow = sheetsUnitExpanded ? '▴' : '▾';
                    unitRow.innerHTML = `<button class="chip ${sheetsUnitFilter || sheetsUnitExpanded ? 'active' : ''} sheets-facet-toggle" onclick="event.stopPropagation(); toggleSheetsFacet('unit')">負責單位 · ${escapeHtml(label)} ${arrow}</button>`;
                }
            }

            if (panel) {
                let options = '';
                if (sheetsTypeExpanded && types.length) {
                    options = [
                        `<button class="chip ${!sheetsTypeFilter ? 'active' : ''}" onclick="event.stopPropagation(); setSheetsTypeFilter('')">全部</button>`,
                        ...types.map(t => {
                            const enc = encodeURIComponent(t);
                            return `<button class="chip ${sheetsTypeFilter === t ? 'active' : ''}" onclick="event.stopPropagation(); setSheetsTypeFilter(decodeURIComponent('${enc}'))">${escapeHtml(t)}</button>`;
                        })
                    ].join('');
                } else if (sheetsUnitExpanded && units.length) {
                    options = [
                        `<button class="chip ${!sheetsUnitFilter ? 'active' : ''}" onclick="event.stopPropagation(); setSheetsUnitFilter('')">全部</button>`,
                        ...units.map(u => {
                            const enc = encodeURIComponent(u);
                            return `<button class="chip ${sheetsUnitFilter === u ? 'active' : ''}" onclick="event.stopPropagation(); setSheetsUnitFilter(decodeURIComponent('${enc}'))">${escapeHtml(u)}</button>`;
                        })
                    ].join('');
                }
                panel.innerHTML = options;
                panel.classList.toggle('open', !!options);
            }
        }

        function sheetItemMatchesFilters(item) {
            if (sheetsStatusFilter !== 'all' && item.done) return false;
            if (sheetsTypeFilter && item.issueType !== sheetsTypeFilter) return false;
            if (sheetsUnitFilter && item.unit !== sheetsUnitFilter) return false;
            return true;
        }


        // ========== 【FEATURE: sheets】9527（邏輯待下沉 features/sheets/logic.js） ==========
        async function loadSheets({ startPoll } = {}) {
            const list = document.getElementById('sheets-list');
            if (!list) {
                stopSheetsPoll();
                return;
            }
            if (!(await ensureFeatureAuthorized('sheets'))) {
                stopSheetsPoll();
                paintFeatureAuthGate(list, 'sheets', '9527');
                return;
            }
            if (startPoll) {
                stopSheetsPoll();
                sheetsTimer = setInterval(() => loadSheets(), REFRESH_MS.sheets);
            }
            const hint = document.getElementById('sheets-sync-hint');
            if (hint) hint.textContent = '同步中…';
            const res = await window.api.sheetsInbox();
            if (!res?.success && (res?.featureScopeMissing || res?.needsAuth || res?.authRevoked)) {
                const ok = await authorizeSheets();
                if (ok) return loadSheets();
            }
            if (!res?.success) {
                currentSheetItems = [];
                currentSheetFacets = { issueTypes: [], units: [] };
                list.innerHTML = `<div class="loading">${escapeHtml(res?.error || '無法讀取試算表')}</div>`;
                if (hint) hint.textContent = res?.needsApi ? '需啟用 API' : '讀取失敗';
                renderSheetsFacetChips();
                return;
            }
            currentSheetItems = res.groups || [];
            currentSheetFacets = res.facets || { issueTypes: [], units: [] };
            if (hint) {
                if (res.newest) hint.textContent = `新進 ${res.newest} 筆`;
                else if (res.pending) hint.textContent = `待處理 ${res.pending} 筆`;
                else hint.textContent = '已同步';
            }
            renderSheetsFacetChips();
            renderSheetsList();
        }

        function renderSheetsList() {
            const list = document.getElementById('sheets-list');
            if (!list) return;
            const groups = currentSheetItems;
            if (!groups.length) {
                list.innerHTML = `<div class="loading">讀不到 9527。請確認已授權 Google 試算表，且帳號可開啟該表。</div>`;
                return;
            }
            const html = groups.map((group, gIdx) => {
                if (group.error) {
                    return `<div class="group-block"><div class="group-header"><span class="group-title">${escapeHtml(group.name)}</span></div><div class="loading">${escapeHtml(group.error)}</div></div>`;
                }
                const visible = (group.items || []).filter(sheetItemMatchesFilters);
                if (!visible.length) {
                    return `
                    <div class="group-block" id="sheet-group-${gIdx}">
                        <div class="group-header"><span class="group-title">${escapeHtml(group.name)}</span><span class="group-count">0</span></div>
                        <div class="group-items"><div class="loading">目前沒有符合篩選的資料</div></div>
                    </div>`;
                }
                const byMonth = new Map();
                visible.forEach(item => {
                    const month = item.sheetName || group.name;
                    if (!byMonth.has(month)) byMonth.set(month, []);
                    byMonth.get(month).push(item);
                });
                const monthBlocks = [...byMonth.entries()].map(([month, monthItems], mIdx) => {
                    const newest = monthItems.filter(i => i.isNew).length;
                    const eventsHtml = monthItems.map(item => {
                    const idx = currentSheetRowIndex(item.key);
                    const badge = item.isNew
                        ? '<span class="badge-new">新</span>'
                        : `<span class="event-time-badge">${escapeHtml(item.status || item.time || '待處理')}</span>`;
                    const previewBits = [
                        item.issueType ? `類型：${item.issueType}` : '',
                        item.unit ? `單位：${item.unit}` : '',
                        ...(item.fields || []).filter(f => /問題內容|電話來源|通報問題單位/.test(f.name)).slice(0, 1).map(f => `${f.name}：${f.value}`)
                    ].filter(Boolean).slice(0, 2);
                    const preview = previewBits.map(t => escapeHtml(t)).join('　');
                    const stateLabel = item.done ? (item.status || '已完成') : (item.status || '待處理');
                    const rowId = item.rowNumber != null ? `#${item.rowNumber}` : '';
                    return `
                    <div class="list-item" onclick="showSheetRowModal(${idx})">
                        <div class="event-header">
                            <div class="event-title-stack">
                                ${rowId ? `<span class="sheet-row-id">${escapeHtml(rowId)}</span>` : ''}
                                <span class="event-title">${escapeHtml(item.title)}</span>
                            </div>
                            ${badge}
                        </div>
                        <div class="event-details">${preview || escapeHtml(stateLabel)}</div>
                    </div>`;
                    }).join('');
                    return `
                    <div class="group-block" id="sheet-group-${gIdx}-${mIdx}">
                        <div class="group-header" onclick="toggleGroup('sheet-group-${gIdx}-${mIdx}')">
                            <span class="group-title">${escapeHtml(group.name)} · ${escapeHtml(month)}</span>
                            <span class="group-count">${newest ? `新 ${newest}` : monthItems.length}</span>
                            <span class="group-chevron">▾</span>
                        </div>
                        <div class="group-items">${eventsHtml}</div>
                    </div>`;
                }).join('');
                return monthBlocks;
            }).join('');
            list.innerHTML = html;
        }

        function currentSheetRowIndex(key) {
            let n = 0;
            for (const group of currentSheetItems) {
                for (const item of group.items || []) {
                    if (item.key === key) return n;
                    n += 1;
                }
            }
            return -1;
        }

        function sheetRowByIndex(index) {
            let n = 0;
            for (const group of currentSheetItems) {
                for (const item of group.items || []) {
                    if (n === index) return item;
                    n += 1;
                }
            }
            return null;
        }

        function sheetFieldLabel(name) {
            return String(name || '')
                .replace(/\(@姓名\)/g, '')
                .replace(/\(自動帶入\)/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function showSheetRowModal(index) {
            const item = sheetRowByIndex(index);
            if (!item) return;
            const skipField = /處理進度|^狀態$/;
            const wideField = /問題內容/;
            const fields = (item.fields || [])
                .filter(f => f.value && !skipField.test(f.name || ''))
                .map(f => {
                    const wide = wideField.test(f.name || '') ? ' wide' : '';
                    return `<div class="sheet-field${wide}"><dt>${escapeHtml(sheetFieldLabel(f.name))}</dt><dd>${escapeHtml(f.value)}</dd></div>`;
                }).join('');
            const chips = [
                item.isNew ? '<span class="badge-new">新</span>' : '',
                `<span class="sheet-chip status">${escapeHtml(item.status || (item.done ? '已完成' : '待處理'))}</span>`,
                item.issueType ? `<span class="sheet-chip">${escapeHtml(item.issueType)}</span>` : '',
                item.unit ? `<span class="sheet-chip">${escapeHtml(item.unit)}</span>` : '',
                item.time ? `<span class="sheet-chip">${escapeHtml(item.time)}</span>` : '',
                item.sheetName ? `<span class="sheet-chip">${escapeHtml(item.sheetName)}</span>` : '',
                item.sourceName ? `<span class="sheet-chip">${escapeHtml(item.sourceName)}</span>` : ''
            ].filter(Boolean).join('');
            const rowId = item.rowNumber != null ? `#${item.rowNumber}` : '';
            setModalKind('sheet-modal');
            document.getElementById('modal-body').innerHTML = `
                <div class="sheet-ticket">
                    <div class="sheet-ticket-heading">
                        ${rowId ? `<div class="sheet-row-id sheet-row-id--modal">${escapeHtml(rowId)}</div>` : ''}
                        <div class="sheet-ticket-title">${escapeHtml(item.title)}</div>
                    </div>
                    <div class="sheet-ticket-meta">${chips}</div>
                    <div class="sheet-ticket-body">
                        <dl class="sheet-kv">${fields || '<div class="loading">沒有欄位內容</div>'}</dl>
                        <div class="sheet-note">
                            <label for="sheet-note-input">備註 · 處理步驟</label>
                            <textarea id="sheet-note-input" placeholder="記下目前做到哪、下一步要做什麼">${escapeHtml(item.note || '')}</textarea>
                            <div class="sheet-note-hint" id="sheet-note-hint">只寫回 M 欄，不會改處理進度。</div>
                        </div>
                    </div>
                    <div class="modal-actions">
                        <button class="btn-primary" onclick="saveSheetNote(${index})">儲存備註</button>
                        ${item.done ? '' : `<button class="btn-ghost" onclick="markSheetRowDone(${index})">標成已完成</button>`}
                        <button class="btn-ghost" onclick="openSheetRow(${index})">在試算表開啟</button>
                    </div>
                </div>
            `;
            document.getElementById('detail-modal').style.display = 'flex';
        }

        function openSheetRow(index) {
            const item = sheetRowByIndex(index);
            if (item?.url) window.api.openExternal(item.url);
        }

        async function saveSheetNote(index) {
            const item = sheetRowByIndex(index);
            if (!item) return;
            const note = document.getElementById('sheet-note-input')?.value ?? '';
            const hint = document.getElementById('sheet-note-hint');
            const res = await window.api.sheetsSaveNote({
                spreadsheetId: item.spreadsheetId,
                sheetName: item.sheetName,
                rowNumber: item.rowNumber,
                noteColumn: item.noteColumn || 'M',
                note
            });
            if (!res?.success) {
                alert(res?.error || '無法儲存備註');
                return;
            }
            item.note = res.note;
            if (hint) hint.textContent = '備註已寫回 M 欄。';
        }

        async function markSheetRowDone(index) {
            const item = sheetRowByIndex(index);
            if (!item) return;
            const note = document.getElementById('sheet-note-input')?.value;
            if (note != null && note !== (item.note || '')) {
                const noteRes = await window.api.sheetsSaveNote({
                    spreadsheetId: item.spreadsheetId,
                    sheetName: item.sheetName,
                    rowNumber: item.rowNumber,
                    noteColumn: item.noteColumn || 'M',
                    note
                });
                if (!noteRes?.success) {
                    alert(noteRes?.error || '備註還沒存成功，先沒有改處理進度');
                    return;
                }
            }
            const res = await window.api.sheetsMarkDone(item);
            if (!res?.success) {
                alert(res?.error || '無法標成已完成');
                return;
            }
            closeModal();
            await loadSheets();
        }

        let sitesVisitsFilter = '';
        let sitesVisitsTimer = null;
        let sitesVisitsColumnDefs = [];
        let sitesVisitsColumnPrefs = [];
        let sitesVisitsLastItems = [];

        function stopSitesVisitsPoll() {
            if (sitesVisitsTimer) {
                clearInterval(sitesVisitsTimer);
                sitesVisitsTimer = null;
            }
        }

        function setSitesVisitsFilter(project) {
            sitesVisitsFilter = project || '';
            loadSitesVisits();
        }


        // ========== 【FEATURE: sitesVisits】網站瀏覽紀錄 ==========
        function getSitesVisitsActiveColumns() {
            const defs = sitesVisitsColumnDefs || [];
            const prefs = sitesVisitsColumnPrefs || [];
            const map = new Map(defs.map(c => [c.id, c]));
            return prefs.map(id => map.get(id)).filter(Boolean);
        }

        function paintSitesVisitsColumnPanel() {
            const panel = document.getElementById('sites-visits-columns-panel');
            if (!panel || !sitesVisitsColumnDefs.length) return;
            const groups = {};
            for (const col of sitesVisitsColumnDefs) {
                if (!groups[col.group]) groups[col.group] = [];
                groups[col.group].push(col);
            }
            const checked = new Set(sitesVisitsColumnPrefs || []);
            panel.innerHTML = Object.entries(groups).map(([group, cols]) => `
                <div class="sites-visits-columns-group">
                    <div class="sites-visits-columns-group-title">${escapeHtml(group)}</div>
                    ${cols.map(col => `
                        <label class="sites-visits-column-check">
                            <input type="checkbox" value="${escapeHtml(col.id)}"
                                ${checked.has(col.id) ? 'checked' : ''}
                                onchange="onSitesVisitsColumnToggle('${escapeHtml(col.id)}', this.checked)">
                            ${escapeHtml(col.label)}
                        </label>
                    `).join('')}
                </div>
            `).join('');
        }

        function toggleSitesVisitsColumnPanel() {
            const panel = document.getElementById('sites-visits-columns-panel');
            if (!panel) return;
            panel.classList.toggle('hidden');
            if (!panel.classList.contains('hidden')) paintSitesVisitsColumnPanel();
        }

        async function onSitesVisitsColumnToggle(columnId, checked) {
            const set = new Set(sitesVisitsColumnPrefs || []);
            if (checked) set.add(columnId);
            else set.delete(columnId);
            const next = sitesVisitsColumnDefs
                .map(c => c.id)
                .filter(id => set.has(id));
            sitesVisitsColumnPrefs = next.length ? next : sitesVisitsColumnDefs.map(c => c.id);
            try {
                await window.api.sitesVisitsSaveColumnPrefs({ columnPrefs: sitesVisitsColumnPrefs });
            } catch (_) {}
            paintSitesVisitsTable(sitesVisitsLastItems);
        }

        function paintSitesVisitsTable(items) {
            const list = document.getElementById('sites-visits-list');
            if (!list) return;
            const cols = getSitesVisitsActiveColumns();
            if (!items.length) {
                list.innerHTML = `<div class="loading">尚無瀏覽資料。請確認 Sites 已嵌入追蹤頁，且同仁以 Google 帳號開啟。</div>`;
                return;
            }
            if (!cols.length) {
                list.innerHTML = `<div class="loading">請至少勾選一個顯示欄位。</div>`;
                return;
            }
            const cellClass = (id) => ['visits', 'clicks', 'links', 'durationLabel', 'lastAt'].includes(id) ? 'num' : '';
            list.innerHTML = `
                <table class="sites-visits-table">
                    <thead>
                        <tr>
                            ${cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${items.map(item => `
                            <tr>
                                ${cols.map(c => {
                                    const val = sitesVisitsCellValue(item, c.id);
                                    const cls = cellClass(c.id);
                                    if (c.id === 'person') {
                                        return `<td class="${cls}">
                                            <div class="sites-visits-person">${escapeHtml(val)}</div>
                                            ${item.empName ? `<div class="sites-visits-emp-name">${escapeHtml(item.empName)}</div>` : ''}
                                        </td>`;
                                    }
                                    return `<td class="${cls}">${escapeHtml(String(val ?? ''))}</td>`;
                                }).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
        }

        function sitesVisitsCellValue(item, columnId) {
            switch (columnId) {
                case 'person': return item.person || item.email || '';
                case 'empNo': return item.empNo || '';
                case 'empCode': return item.empCode || '';
                case 'empName': return item.empName || '';
                case 'jobTitle': return item.jobTitle || '';
                case 'jobDuty': return item.jobDuty || '';
                case 'dept': return item.dept || '';
                case 'region': return item.region || '';
                case 'extension': return item.extension || '';
                case 'deptPath': return item.deptPath || '';
                case 'project': return item.project || '';
                case 'lastAt': return item.lastAt || '—';
                case 'visits': return item.visits ?? 0;
                case 'clicks': return item.clicks ?? 0;
                case 'links': return item.links ?? 0;
                case 'durationLabel': return item.durationLabel || '0 秒';
                default: return '';
            }
        }

        async function exportSitesVisitsExcel() {
            const hint = document.getElementById('sites-visits-sync-hint');
            if (hint) hint.textContent = '匯出中…';
            const res = await window.api.sitesVisitsExportExcel({
                project: sitesVisitsFilter,
                columnPrefs: sitesVisitsColumnPrefs
            });
            if (res?.canceled) {
                if (hint) hint.textContent = `造訪 ${sitesVisitsLastItems.reduce((n, i) => n + (i.visits || 0), 0)}`;
                return;
            }
            if (!res?.success) {
                if (hint) hint.textContent = res?.error || '匯出失敗';
                return;
            }
            if (hint) hint.textContent = '已輸出 Excel';
            setTimeout(() => loadSitesVisits(), 1200);
        }

        async function loadSitesVisits(opts = {}) {
            const list = document.getElementById('sites-visits-list');
            if (!list) return;
            if (!(await ensureFeatureAuthorized('sitesVisits'))) {
                stopSitesVisitsPoll();
                paintFeatureAuthGate(list, 'sitesVisits', '網站瀏覽紀錄');
                return;
            }
            if (opts.startPoll) {
                stopSitesVisitsPoll();
                sitesVisitsTimer = setInterval(() => loadSitesVisits(), REFRESH_MS.sitesVisits);
            }
            const hint = document.getElementById('sites-visits-sync-hint');
            const summary = document.getElementById('sites-visits-summary');
            const chips = document.getElementById('sites-visits-chips');
            if (hint) hint.textContent = '同步中…';
            const res = await window.api.sitesVisitsReport({ project: sitesVisitsFilter });
            if (!res?.success) {
                if (hint) hint.textContent = res?.needsSetup ? '待設定' : '同步失敗';
                list.innerHTML = `<div class="loading">${escapeHtml(res?.error || '無法載入瀏覽紀錄')}</div>`;
                if (summary) summary.innerHTML = '';
                return;
            }
            sitesVisitsColumnDefs = res.columns || sitesVisitsColumnDefs;
            sitesVisitsColumnPrefs = res.columnPrefs || sitesVisitsColumnPrefs;
            sitesVisitsLastItems = res.items || [];
            let hintText = `造訪 ${res.totalVisits || 0} · 點擊 ${res.totalClicks || 0} · 超連結 ${res.totalLinks || 0}`;
            if (res.erpError) hintText += ` · ERP：${res.erpError}`;
            if (hint) hint.textContent = hintText;
            if (summary) {
                summary.innerHTML = `
                    <span>造訪 ${res.totalVisits || 0}</span>
                    <span>點擊 ${res.totalClicks || 0}</span>
                    <span>超連結 ${res.totalLinks || 0}</span>
                    <span>總瀏覽 ${escapeHtml(res.durationLabel || '0 秒')}</span>
                    <span>組合 ${(res.items || []).length} 筆</span>
                `;
            }
            if (chips) {
                const projects = res.projects || [];
                chips.innerHTML = [
                    `<button class="chip ${!sitesVisitsFilter ? 'active' : ''}" onclick="event.stopPropagation(); setSitesVisitsFilter('')">全部</button>`,
                    ...projects.map(p => {
                        const nameAttr = encodeURIComponent(p.name);
                        return `<button class="chip ${sitesVisitsFilter === p.name ? 'active' : ''}" onclick="event.stopPropagation(); setSitesVisitsFilter(decodeURIComponent('${nameAttr}'))">${escapeHtml(p.name)}</button>`;
                    })
                ].join('');
            }
            const items = res.items || [];
            if (!document.getElementById('sites-visits-columns-panel')?.classList.contains('hidden')) {
                paintSitesVisitsColumnPanel();
            }
            paintSitesVisitsTable(items);
        }

        async function openSitesDeptOrg() {
            if (!window.api.sitesVisitsDeptOrgOpen) return;
            const res = await window.api.sitesVisitsDeptOrgOpen();
            if (!res?.success) alert(res?.error || '無法開啟部門組織視窗');
        }

        // --- Gmail ---
        let currentMailContext = null;
        let currentMailLabel = 'INBOX';
        let orgContacts = [];
        let contactPickIndex = -1;
        let contactPickField = '';

        function updateSyncHint(packet) {
            const hint = document.getElementById('mail-sync-hint');
            if (!hint) return;
            const pendingCount = (packet?.pending?.markRead || 0) + (packet?.pending?.replies || 0);
            if (packet?.syncing) {
                hint.textContent = '同步中…';
                return;
            }
            const time = packet?.lastSync ? new Date(packet.lastSync).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '--';
            hint.textContent = pendingCount ? `${pendingCount} 則待同步 · ${time}` : `每 1 分鐘同步 · ${time}`;
        }

        function isMailUnread(m) {
            if (m?.isUnread === false) return false;
            if (m?.isUnread === true) return true;
            return (m?.labelIds || []).includes('UNREAD');
        }

        function isMailImportant(m) {
            if (m?.isImportant === true) return true;
            return (m?.labelIds || []).includes('IMPORTANT');
        }

        function sortMailByPriority(emails) {
            return [...(emails || [])].sort((a, b) => {
                const diff = Number(isMailImportant(b)) - Number(isMailImportant(a));
                return diff;
            });
        }

        const GMAIL_IMPORTANT_ICON = `<svg class="mail-important-icon" viewBox="0 0 18 18" aria-hidden="true"><path fill="#F4B400" d="M3 2v14l5-3.25V6.75L13 2v14l-5-3.25V6.75L3 2z"/></svg>`;

        function renderMailLeadIcon(m) {
            if (isMailImportant(m)) {
                return `<div class="mail-icon is-important" title="重要">${GMAIL_IMPORTANT_ICON}</div>`;
            }
            return `<div class="mail-icon">${escapeHtml((m.from || '?').charAt(0).toUpperCase())}</div>`;
        }

        function renderMailListItems(emails) {
            const unread = sortMailByPriority((emails || []).filter(isMailUnread));
            return unread.map(renderMailItem).join('');
        }

        function applyGmailPacket(res, { silent } = {}) {
            if (!res?.success) return;
            if (res.contacts) orgContacts = res.contacts;
            updateSyncHint(res);

            const list = document.getElementById('gmail-list');
            const chips = document.getElementById('mail-chips');
            if (!list || !chips) return;
            const labels = res.labels || [];
            let emails = sortMailByPriority((res.emails || []).filter(isMailUnread));
            if (currentMailLabel) {
                emails = emails.filter(e => (e.labelIds || []).includes(currentMailLabel));
            }
            const inboxCount = res.inboxUnread > 0 ? ` (${res.inboxUnread})` : '';
            chips.innerHTML = [
                `<button class="chip ${currentMailLabel === 'INBOX' ? 'active' : ''}" onclick="loadGmail('INBOX')">收件匣${inboxCount}</button>`,
                ...labels.map(l => {
                    const count = l.unreadCount > 0 ? ` (${l.unreadCount})` : '';
                    return `<button class="chip ${currentMailLabel === l.id ? 'active' : ''}" onclick="loadGmail('${l.id}')">${escapeHtml(l.name)}${count}</button>`;
                })
            ].join('');

            if (!emails.length) {
                list.innerHTML = res.syncing && !silent
                    ? `<div class='loading'>第一次同步未讀郵件中...</div>`
                    : `<div class='loading'>目前沒有未讀郵件</div>`;
                return;
            }

            list.innerHTML = renderMailListItems(emails);
        }

        function renderMailItem(m) {
            const unread = isMailUnread(m);
            const tags = (m.tags || []).map(t => `<span class="mail-label-tag">${escapeHtml(t.name)}</span>`).join('');
            return `
                <div class="list-item mail-item${unread ? '' : ' mail-item-read'}">
                    <div class="mail-row">
                        ${unread ? `<input type="checkbox" class="mail-checkbox" title="標示為已讀" onclick="markMailRead(event, '${m.id}')">` : '<span class="mail-checkbox-spacer" aria-hidden="true"></span>'}
                        <div class="mail-content" onclick="showMailModal('${m.id}')">
                            <div class="mail-header">${renderMailLeadIcon(m)}<span class="mail-from">${escapeHtml(m.from)}</span></div>
                            <div class="mail-subject">${escapeHtml(m.subject)}</div>
                            <div class="mail-snippet">${escapeHtml(m.snippet)}</div>
                            ${tags ? `<div class="mail-labels">${tags}</div>` : ''}
                        </div>
                    </div>
                </div>`;
        }


        // ========== 【FEATURE: gmail】未讀郵件 ==========
        async function loadGmail(labelId = currentMailLabel) {
            currentMailLabel = labelId || 'ALL';
            const list = document.getElementById('gmail-list');
            if (list && !(await ensureFeatureAuthorized('gmail'))) {
                paintFeatureAuthGate(list, 'gmail', '未讀郵件');
                return;
            }
            const res = await window.api.getGmail(currentMailLabel);
            applyGmailPacket(res);
        }

        async function markMailRead(event, id) {
            event.stopPropagation();
            event.preventDefault();
            await window.api.markGmailRead(id);
        }

        let replyRecipients = { to: [], cc: [], bcc: [] };
        let replyMode = 'reply';
        let showCc = false;
        let showBcc = false;

        function personKey(p) {
            return (p.email || '').toLowerCase();
        }

        function uniquePeople(list, exceptEmail = '') {
            const seen = new Set();
            const skip = (exceptEmail || '').toLowerCase();
            return (list || []).filter(p => {
                const key = personKey(p);
                if (!key || key === skip || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        function displayName(p) {
            return p.name || p.email;
        }

        function setReplyMode(mode) {
            replyMode = mode;
            const d = currentMailContext;
            const me = d.myEmail || '';
            if (mode === 'all') {
                const toPeople = uniquePeople([d.fromParsed, d.replyToParsed, ...(d.toParsed || [])], me);
                replyRecipients = {
                    to: toPeople.length ? toPeople : uniquePeople([d.replyToParsed || d.fromParsed]),
                    cc: uniquePeople(d.ccParsed || [], me).filter(p => !toPeople.some(t => personKey(t) === personKey(p))),
                    bcc: []
                };
                showCc = replyRecipients.cc.length > 0;
            } else {
                replyRecipients = {
                    to: uniquePeople([d.replyToParsed || d.fromParsed]),
                    cc: [],
                    bcc: []
                };
                showCc = false;
            }
            showBcc = false;
            renderReplyComposer();
        }

        function renderAddrChips(field) {
            return replyRecipients[field].map((p, i) => `
                <span class="addr-chip" title="${escapeHtml(p.email)}">
                    ${escapeHtml(displayName(p))}
                    <button type="button" onclick="removeRecipient('${field}', ${i})">×</button>
                </span>
            `).join('');
        }

        function matchContacts(query) {
            const s = (query || '').trim().toLowerCase();
            const existing = new Set([...replyRecipients.to, ...replyRecipients.cc, ...replyRecipients.bcc].map(personKey));
            const pool = orgContacts.filter(c => c.email && !existing.has(c.email.toLowerCase()));
            if (!s) return pool.slice(0, 12);
            return pool.filter(c =>
                (c.name || '').toLowerCase().includes(s) ||
                (c.email || '').toLowerCase().includes(s) ||
                (c.org || '').toLowerCase().includes(s)
            ).slice(0, 12);
        }

        function renderContactDropdown(field, query, show) {
            const drop = document.getElementById(`${field}-dropdown`);
            if (!drop) return;
            const hits = matchContacts(query);
            if (!show || !hits.length) {
                drop.style.display = 'none';
                drop.innerHTML = '';
                contactPickIndex = -1;
                return;
            }
            contactPickField = field;
            drop.innerHTML = hits.map((c, i) => `
                <button type="button" class="contact-option ${i === contactPickIndex ? 'active' : ''}"
                    onmousedown="event.preventDefault(); pickContact('${field}', '${escapeHtml(c.email).replace(/'/g, "\\'")}', '${escapeHtml(c.name || '').replace(/'/g, "\\'")}')">
                    ${escapeHtml(c.name || c.email)}
                    <small>${escapeHtml(c.email)}${c.org ? ' · ' + escapeHtml(c.org) : ''}</small>
                </button>
            `).join('');
            drop.style.display = 'block';
        }

        function pickContact(field, email, name) {
            addRecipient(field, { email, name });
        }

        function renderRecipientRow(field, label, visible) {
            if (!visible && field !== 'to') return '';
            return `
                <div class="recipient-row">
                    <span class="recipient-label">${label}</span>
                    <div class="recipient-wrap">
                        <div class="recipient-field" onclick="document.getElementById('${field}-input')?.focus()">
                            ${renderAddrChips(field)}
                            <input id="${field}-input" class="recipient-input" placeholder="搜尋姓名或信箱"
                                oninput="onRecipientInput('${field}')"
                                onfocus="onRecipientInput('${field}', true)"
                                onkeydown="onRecipientKey(event, '${field}')"
                                onblur="onRecipientBlur('${field}')">
                        </div>
                        <div id="${field}-dropdown" class="contact-dropdown"></div>
                    </div>
                </div>`;
        }

        function suggestedPeople() {
            const d = currentMailContext || {};
            const existing = new Set([...replyRecipients.to, ...replyRecipients.cc, ...replyRecipients.bcc].map(personKey));
            existing.add((d.myEmail || '').toLowerCase());
            return uniquePeople([d.fromParsed, d.replyToParsed, ...(d.toParsed || []), ...(d.ccParsed || [])])
                .filter(p => p.email && !existing.has(personKey(p)));
        }

        function renderReplyComposer() {
            const box = document.getElementById('reply-box');
            if (!box) return;
            const html = document.getElementById('reply-editor')?.innerHTML || '';
            const quoteOn = document.getElementById('quote-original')?.checked;
            const suggestions = suggestedPeople();
            box.innerHTML = `
                <div class="reply-toolbar">
                    <div class="reply-modes">
                        <button type="button" class="chip ${replyMode === 'reply' ? 'active' : ''}" onclick="setReplyMode('reply')">回覆</button>
                        <button type="button" class="chip ${replyMode === 'all' ? 'active' : ''}" onclick="setReplyMode('all')">回覆全部</button>
                    </div>
                    <div>
                        <button type="button" class="link-btn ${showCc ? 'active' : ''}" onclick="toggleCopyField('cc')">副本</button>
                        <button type="button" class="link-btn ${showBcc ? 'active' : ''}" onclick="toggleCopyField('bcc')">密件副本</button>
                    </div>
                </div>
                ${renderRecipientRow('to', '收件人', true)}
                ${renderRecipientRow('cc', '副本', showCc)}
                ${renderRecipientRow('bcc', '密件', showBcc)}
                ${suggestions.length ? `<div class="suggest-row">${suggestions.map(p =>
                    `<button type="button" class="suggest-chip" onclick="addSuggested('${escapeHtml(p.email).replace(/'/g, "\\'")}', '${escapeHtml(p.name || '').replace(/'/g, "\\'")}')">+ ${escapeHtml(displayName(p))}</button>`
                ).join('')}</div>` : ''}
                <div class="editor-toolbar" onmousedown="event.preventDefault()">
                    <button type="button" title="粗體" onclick="formatReply('bold')"><b>B</b></button>
                    <button type="button" title="斜體" onclick="formatReply('italic')"><i>I</i></button>
                    <button type="button" title="底線" onclick="formatReply('underline')"><u>U</u></button>
                    <button type="button" title="項目" onclick="formatReply('insertUnorderedList')">•</button>
                    <button type="button" title="編號" onclick="formatReply('insertOrderedList')">1.</button>
                    <button type="button" title="引言" onclick="formatReply('formatBlock','blockquote')">❝</button>
                    <button type="button" title="連結" onclick="formatReply('createLink')">🔗</button>
                    <button type="button" title="清除格式" onclick="formatReply('removeFormat')">Tx</button>
                </div>
                <div id="reply-editor" class="reply-editor" contenteditable="true" data-placeholder="寫下回覆..."></div>
                <div class="reply-actions">
                    <label class="quote-check"><input type="checkbox" id="quote-original" ${quoteOn ? 'checked' : ''}> 附上原文</label>
                    <div style="display:flex;gap:8px;">
                        <button type="button" class="btn-ghost" onclick="closeModal()">取消</button>
                        <button type="button" class="btn-primary" id="send-btn" onclick="sendMailReply()">送出回覆</button>
                    </div>
                </div>
            `;
            const editor = document.getElementById('reply-editor');
            if (html) editor.innerHTML = html;
        }

        function toggleCopyField(field) {
            if (field === 'cc') showCc = !showCc;
            if (field === 'bcc') showBcc = !showBcc;
            renderReplyComposer();
        }

        function addRecipient(field, person, skipRender) {
            if (!person?.email) return;
            if (replyRecipients[field].some(p => personKey(p) === personKey(person))) return;
            replyRecipients[field].push({ name: person.name || '', email: person.email });
            if (!skipRender) renderReplyComposer();
        }

        function addSuggested(email, name) {
            addRecipient('to', { email, name });
        }

        function removeRecipient(field, index) {
            replyRecipients[field].splice(index, 1);
            renderReplyComposer();
        }

        function commitRecipientInput(field) {
            const input = document.getElementById(`${field}-input`);
            if (!input) return;
            const raw = input.value.trim().replace(/[,;]+$/, '');
            if (!raw) return;
            const hits = matchContacts(raw);
            const exact = hits.find(c =>
                c.email.toLowerCase() === raw.toLowerCase() ||
                (c.name || '').toLowerCase() === raw.toLowerCase()
            );
            if (exact) {
                addRecipient(field, exact, true);
            } else {
                raw.split(/[,;]+/).map(s => s.trim()).filter(s => s.includes('@')).forEach(email => {
                    addRecipient(field, { email, name: '' }, true);
                });
            }
            renderReplyComposer();
            document.getElementById(`${field}-input`)?.focus();
        }

        function onRecipientInput(field, fromFocus) {
            const input = document.getElementById(`${field}-input`);
            contactPickIndex = 0;
            renderContactDropdown(field, input?.value || '', true);
            if (fromFocus && !(input?.value || '') && !matchContacts('').length) {
                renderContactDropdown(field, '', false);
            }
        }

        function onRecipientBlur(field) {
            setTimeout(() => {
                renderContactDropdown(field, '', false);
                commitRecipientInput(field);
            }, 120);
        }

        function onRecipientKey(event, field) {
            const drop = document.getElementById(`${field}-dropdown`);
            const open = drop && drop.style.display === 'block';
            const hits = matchContacts(event.target.value);
            if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                if (!hits.length) return;
                if (event.key === 'ArrowDown') contactPickIndex = (contactPickIndex + 1) % hits.length;
                else contactPickIndex = (contactPickIndex - 1 + hits.length) % hits.length;
                renderContactDropdown(field, event.target.value, true);
                return;
            }
            if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
                event.preventDefault();
                if (open && hits[contactPickIndex]) {
                    pickContact(field, hits[contactPickIndex].email, hits[contactPickIndex].name);
                    return;
                }
                commitRecipientInput(field);
            } else if (event.key === 'Escape') {
                renderContactDropdown(field, '', false);
            } else if (event.key === 'Backspace' && !event.target.value && replyRecipients[field].length) {
                replyRecipients[field].pop();
                renderReplyComposer();
                document.getElementById(`${field}-input`)?.focus();
            }
        }

        function formatReply(cmd, value) {
            const editor = document.getElementById('reply-editor');
            editor?.focus();
            if (cmd === 'createLink') {
                const url = prompt('連結網址', 'https://');
                if (url) document.execCommand('createLink', false, url);
                return;
            }
            document.execCommand(cmd, false, value || null);
        }

        async function showMailModal(id) {
            setModalKind('');
            document.getElementById('detail-modal').style.display = 'flex';
            document.getElementById('modal-body').innerHTML = `<div class="loading">讀取信件內文中...</div>`;

            const res = await window.api.getGmailDetail(id);
            if (res.success) {
                currentMailContext = res.detail;
                replyMode = 'reply';
                showCc = false;
                showBcc = false;
                replyRecipients = {
                    to: uniquePeople([res.detail.replyToParsed || res.detail.fromParsed]),
                    cc: [],
                    bcc: []
                };

                window.api.markGmailRead(id);

                document.getElementById('modal-body').innerHTML = `
                    <div class="mail-view">
                        <div class="modal-title">📧 ${escapeHtml(res.detail.subject)}</div>
                        <div class="mail-meta">寄件者：${escapeHtml(res.detail.from)}</div>
                        <div class="mail-original">
                            <iframe id="mail-iframe"></iframe>
                        </div>
                        <div class="reply-box" id="reply-box"></div>
                    </div>
                `;
                renderReplyComposer();

                const iframe = document.getElementById('mail-iframe');
                if (res.detail.isHtml) iframe.srcdoc = res.detail.body;
                else iframe.srcdoc = `<pre style="font-family: sans-serif; font-size: 1.05em; white-space: pre-wrap; padding: 15px; color:#3f3c38;">${escapeHtml(res.detail.body)}</pre>`;
            }
        }

        async function sendMailReply() {
            const editor = document.getElementById('reply-editor');
            let html = (editor?.innerHTML || '').trim();
            const text = (editor?.innerText || '').trim();
            if (!text && !replyRecipients.to.length) return alert('請輸入回覆內容！');
            if (!text) return alert('請輸入回覆內容！');
            if (!replyRecipients.to.length) return alert('請至少選擇一位收件人');

            if (document.getElementById('quote-original')?.checked && currentMailContext?.body) {
                const quoted = currentMailContext.isHtml
                    ? currentMailContext.body
                    : `<pre style="white-space:pre-wrap;">${escapeHtml(currentMailContext.body)}</pre>`;
                html += `<p style="color:#8a847c;font-size:12px;margin-top:16px;">── 原文 ──</p><blockquote style="border-left:3px solid #ddd;padding-left:12px;color:#666;">${quoted}</blockquote>`;
            }

            const btn = document.getElementById('send-btn');
            btn.textContent = '發送中...';
            btn.disabled = true;

            const res = await window.api.replyGmail({
                to: replyRecipients.to,
                cc: replyRecipients.cc,
                bcc: replyRecipients.bcc,
                replyTo: currentMailContext.replyTo,
                subject: currentMailContext.subject,
                threadId: currentMailContext.threadId,
                messageIdHeader: currentMailContext.messageIdHeader,
                html,
                text
            });

            if (res.success) {
                alert(res.queued ? '已排入同步佇列，約 30 秒內會連同其他變更一起寄出。' : '回覆已成功送出！');
                closeModal();
            } else {
                alert('回覆失敗：' + res.error);
                btn.textContent = '送出回覆';
                btn.disabled = false;
            }
        }

        let gchatAlertTimer = null;
        let gchatAlertEnabled = true;
        let currentGchatContext = null;
        let gchatMyUserName = '';
        let gchatMyIds = [];
        let gchatMyLabels = [];
        let gchatPinnedContacts = [];
        let gchatPinnedSpaces = [];
        let gchatSearchTimer = null;
        let gchatListMessages = [];
        let gchatPinnedUnread = { contacts: {}, spaces: {} };

        function isGchatMineMessage(m) {
            if (!m) return false;
            if (m.isMine === true) return true;
            if (m.sender === '我') return true;
            const sender = String(m.senderName || '').trim();
            if (sender) {
                const keys = new Set();
                const add = (v) => {
                    const s = String(v || '').trim();
                    if (!s) return;
                    keys.add(s);
                    keys.add(s.toLowerCase());
                    if (s.startsWith('users/')) {
                        const bare = s.slice(6);
                        keys.add(bare);
                        keys.add(bare.toLowerCase());
                        if (bare.startsWith('c') && bare.length > 1) {
                            keys.add(bare.slice(1));
                            keys.add(`users/${bare.slice(1)}`);
                        }
                    } else {
                        keys.add(`users/${s}`);
                        keys.add(`users/${s.toLowerCase()}`);
                    }
                };
                add(gchatMyUserName);
                (gchatMyIds || []).forEach(add);
                if (keys.has(sender) || keys.has(sender.toLowerCase())) return true;
                const senderId = sender.startsWith('users/') ? sender.slice(6) : sender;
                if (senderId && (keys.has(senderId) || keys.has(senderId.toLowerCase()))) return true;
            }
            const label = String(m.sender || '').trim();
            if (label && (gchatMyLabels || []).includes(label)) return true;
            return false;
        }

        function applyGchatIdentityFromRes(res) {
            if (!res) return;
            if (res.myUserName) gchatMyUserName = res.myUserName;
            if (Array.isArray(res.myIds)) gchatMyIds = res.myIds;
            if (Array.isArray(res.myLabels)) gchatMyLabels = res.myLabels;
            if (Array.isArray(res.pinnedContacts)) gchatPinnedContacts = res.pinnedContacts;
            if (Array.isArray(res.pinnedSpaces)) gchatPinnedSpaces = res.pinnedSpaces;
            if (res.pinnedUnread && typeof res.pinnedUnread === 'object') {
                gchatPinnedUnread = {
                    contacts: res.pinnedUnread.contacts || {},
                    spaces: res.pinnedUnread.spaces || {}
                };
            }
        }
        /** @deprecated Phase 1 已移除 Renderer Server Poll；保留 stub 供 widget 卸載呼叫 */
        function stopGchatPoll() {}

        function stopGchatAlertPoll() {
            if (gchatAlertTimer) {
                clearInterval(gchatAlertTimer);
                gchatAlertTimer = null;
            }
        }

        // [Important] Toast Dedupe Owner = Main only（ADR 0001）
        // Renderer 不再維護 alerted-id / processGchatAlerts；提醒只由 Main notifyNewGchatAlerts 觸發

        function syncGchatViewing() {
            if (!currentGchatContext?.spaceName) {
                window.api.gchatSetViewing?.(null);
                return;
            }
            window.api.gchatSetViewing?.({
                spaceName: currentGchatContext.spaceName,
                threadName: currentGchatContext.threadName || '',
                messageName: currentGchatContext.name || '',
                isDm: !!currentGchatContext.isDm
            });
        }

        async function syncGchatAlertPrefAndPoll() {
            try {
                const prefs = await window.api.gchatGetPrefs?.();
                if (prefs?.success !== false) gchatAlertEnabled = prefs?.alertPopup !== false;
            } catch (_) {
                gchatAlertEnabled = true;
            }
            const box = document.getElementById('gchat-alert-popup');
            if (box) box.checked = !!gchatAlertEnabled;
            stopGchatAlertPoll();
            await window.api.gchatAlertWatch?.(!!gchatAlertEnabled);
        }

        async function toggleGchatAlertPopup(enabled) {
            gchatAlertEnabled = !!enabled;
            await window.api.gchatSavePrefs?.({ alertPopup: gchatAlertEnabled });
            if (gchatAlertEnabled) {
                await syncGchatAlertPrefAndPoll();
            } else {
                stopGchatAlertPoll();
                try {
                    await window.api.gchatAlertWatch?.(false);
                    await window.api.gchatToastHide?.();
                } catch (_) {}
            }
        }

        async function toggleCloseToTray(enabled) {
            await window.api.gchatSavePrefs?.({ closeToTray: !!enabled });
        }

        async function minimizeAppToTray() {
            await window.api.windowMinimize?.();
            document.getElementById('app-settings-menu')?.classList.remove('open');
        }

        async function quitAppFully() {
            if (!confirm('確定要結束 LifeTour？結束後不會再跳出 Little Reply 提醒。')) return;
            await window.api.appQuit?.();
        }

        function updateGchatHint(res) {
            const hint = document.getElementById('gchat-sync-hint');
            if (!hint) return;
            if (res?.needsApi) {
                hint.textContent = '需啟用 API';
                return;
            }
            if (res?.needsReauth || res?.featureScopeMissing || res?.needsAuth || res?.authRevoked) {
                hint.textContent = '需授權';
                return;
            }
            if (res?.syncing) {
                hint.textContent = '同步中…';
                return;
            }
            const time = res?.lastSync
                ? new Date(res.lastSync).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
                : '--';
            const pending = res?.pending?.markRead || 0;
            const dirErr = res?.directoryError ? ` · ${res.directoryError}` : '';
            const unresolved = res?.unresolvedSenders || 0;
            if (unresolved && res?.directoryError) {
                hint.textContent = `姓名未解析 ${unresolved}${dirErr}`;
                return;
            }
            if (pending) {
                hint.textContent = res?.serverSynced === false
                    ? `${pending} 則已讀待同步 · ${time}`
                    : `${pending} 則待同步 · ${time}`;
                return;
            }
            hint.textContent = `每 30 秒 · ${time}`;
        }

        let gchatMediaStore = {};
        let gchatMediaSeq = 0;
        let gchatLightboxExternalUrl = '';

        function stashGchatMedia(item) {
            const id = `gm${++gchatMediaSeq}`;
            gchatMediaStore[id] = item;
            return id;
        }

        function closeGchatLightbox(event) {
            if (event && event.target !== event.currentTarget) return;
            window.GchatLightboxZoom?.detach?.();
            const box = document.getElementById('gchat-lightbox');
            if (box) {
                box.classList.remove('is-open');
                const body = document.getElementById('gchat-lb-body');
                if (body) body.innerHTML = '';
            }
            gchatLightboxExternalUrl = '';
            const hint = document.getElementById('gchat-lb-zoom-hint');
            if (hint) hint.textContent = '';
        }

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            const box = document.getElementById('gchat-lightbox');
            if (box?.classList.contains('is-open')) {
                event.stopPropagation();
                closeGchatLightbox();
            }
        });

        function openGchatLightboxExternal() {
            if (gchatLightboxExternalUrl) window.api.openExternal(gchatLightboxExternalUrl);
        }

        function pickGchatImageSrc(item) {
            const dataUrl = String(item?.dataUrl || '').trim();
            if (dataUrl.startsWith('data:')) return dataUrl;
            const preview = String(item?.previewUrl || '').trim();
            if (preview.startsWith('data:')) return preview;
            if (item?.kind === 'gif') {
                const uri = String(item.uri || '').trim();
                if (uri.startsWith('http')) return uri;
            }
            return '';
        }

        function pickGchatPdfPreviewSrc(item) {
            const raw = pickGchatImageSrc(item) || String(item?.previewUrl || item?.dataUrl || item?.uri || '').trim();
            if (!raw) return '';
            return window.GchatPdfViewer?.resolvePdfViewerSrc?.(raw) || raw;
        }

        function openGchatMediaPreview(id) {
            const item = gchatMediaStore[id];
            if (!item) return;
            const isPdf = item.kind === 'pdf' || /pdf/i.test(item.contentType || '') || /\.pdf$/i.test(item.name || '');
            const src = isPdf
                ? pickGchatPdfPreviewSrc(item)
                : (pickGchatImageSrc(item) || item.previewUrl || item.dataUrl || '');
            const title = document.getElementById('gchat-lb-title');
            const body = document.getElementById('gchat-lb-body');
            const extBtn = document.getElementById('gchat-lb-open-ext');
            const box = document.getElementById('gchat-lightbox');
            if (!body || !box) return;

            if (title) title.textContent = item.name || (isPdf ? 'PDF 預覽' : '圖片預覽');
            gchatLightboxExternalUrl = item.openUrl || item.downloadUri || (src.startsWith('http') ? src : '');
            if (extBtn) extBtn.style.display = gchatLightboxExternalUrl ? 'inline-block' : 'none';

            if (isPdf && src) {
                body.innerHTML = '';
                if (!window.GchatPdfViewer?.appendPdfViewer?.(body, src, { title: 'PDF' })) {
                    const frame = document.createElement('iframe');
                    frame.title = 'PDF';
                    frame.src = src;
                    body.appendChild(frame);
                }
            } else if (src) {
                body.innerHTML = '';
                const img = document.createElement('img');
                img.src = src;
                img.alt = item.name || '圖片';
                img.draggable = false;
                window.GchatLightboxZoom?.attach?.(body, img, {
                    onScaleChange(scale) {
                        const hint = document.getElementById('gchat-lb-zoom-hint');
                        if (!hint) return;
                        if (scale <= 1.01) {
                            hint.textContent = '滾輪縮放';
                            return;
                        }
                        const img = document.querySelector('#gchat-lb-body .gchat-lb-zoom-img');
                        const w = img ? Math.round(Number(img.style.width.replace('px', '')) || 0) : 0;
                        const h = img ? Math.round(Number(img.style.height.replace('px', '')) || 0) : 0;
                        hint.textContent = w && h ? `${w}×${h}px · 拖曳平移` : `${Math.round(scale * 100)}% · 拖曳平移`;
                    }
                });
                const hint = document.getElementById('gchat-lb-zoom-hint');
                if (hint) hint.textContent = '滾輪縮放';
            } else if (item.openUrl || item.downloadUri) {
                window.api.openExternal(item.openUrl || item.downloadUri);
                return;
            } else {
                alert('無法預覽此檔案');
                return;
            }
            box.classList.add('is-open');
        }

        function renderGchatMedia(media, opts = {}) {
            const list = (media || []).filter((item) => {
                if (item?.cardDecor) return false;
                if ((item?.kind === 'image' || /^image\//i.test(item?.contentType || ''))
                    && !item?.resourceName
                    && !item?.driveFileId
                    && !String(item?.dataUrl || '').startsWith('data:')) {
                    const src = String(item?.previewUrl || item?.uri || '');
                    if (/^https?:\/\//i.test(src)) return false;
                }
                if (opts.hideCardDecor
                    && !item?.resourceName
                    && !item?.driveFileId
                    && (item?.kind === 'image' || item?.kind === 'gif')) {
                    const src = String(item?.previewUrl || item?.uri || item?.dataUrl || '');
                    if (/^https?:\/\//i.test(src)) return false;
                }
                return true;
            });
            if (!list.length) return '';
            const parts = list.map(item => {
                const id = stashGchatMedia(item);
                const src = pickGchatImageSrc(item);
                const isImage = item.kind === 'gif' || item.kind === 'image' || /^image\//i.test(item.contentType || '');
                const isPdf = item.kind === 'pdf' || /pdf/i.test(item.contentType || '') || /\.pdf$/i.test(item.name || '');

                if (src && isImage) {
                    const safe = escapeHtml(src).replace(/"/g, '&quot;');
                    return `<button type="button" class="gchat-media-card" onclick="openGchatMediaPreview('${id}')" title="點擊放大預覽">
                        <img class="gchat-media" src="${safe}" alt="${escapeHtml(item.name || '圖片')}" draggable="false">
                        <span class="gchat-media-hint">點擊放大預覽</span>
                    </button>`;
                }
                // 辨識為圖片但尚未有位元組：顯示可點名稱，避免只剩「📎 image.png」
                if (isImage) {
                    const label = escapeHtml(item.name || '圖片');
                    if (item.openUrl || item.downloadUri) {
                        const url = escapeHtml(item.openUrl || item.downloadUri).replace(/'/g, "\\'");
                        return `<a class="gchat-file-link" href="#" onclick="event.preventDefault(); window.api.openExternal('${url}')">🖼️ ${label}（開啟原圖）</a>`;
                    }
                    return `<button type="button" class="gchat-pdf-thumb" onclick="openGchatMediaPreview('${id}')">🖼️ ${label}<span class="gchat-media-hint">尚無預覽資料</span></button>`;
                }
                if (isPdf) {
                    const label = escapeHtml(item.name || 'PDF 檔案');
                    const pdfSrc = pickGchatPdfPreviewSrc(item);
                    if (pdfSrc) {
                        const safe = escapeHtml(pdfSrc).replace(/"/g, '&quot;');
                        return `<button type="button" class="gchat-pdf-preview-card" onclick="openGchatMediaPreview('${id}')" title="點擊放大預覽">
                            <iframe class="gchat-pdf-inline" src="${safe}" title="${label}" tabindex="-1"></iframe>
                            <span class="gchat-media-hint">📄 ${label} · 點擊放大</span>
                        </button>`;
                    }
                    if (src || item.openUrl || item.downloadUri) {
                        return `<div class="gchat-media-card">
                            <button type="button" class="gchat-pdf-thumb" onclick="openGchatMediaPreview('${id}')">📄 ${label}<span class="gchat-media-hint">點擊預覽</span></button>
                        </div>`;
                    }
                    return `<div class="gchat-file-link">📄 ${label}</div>`;
                }
                if (item.openUrl || item.downloadUri) {
                    const url = escapeHtml(item.openUrl || item.downloadUri).replace(/'/g, "\\'");
                    return `<a class="gchat-file-link" href="#" onclick="event.preventDefault(); window.api.openExternal('${url}')">📎 ${escapeHtml(item.name || '附件')}</a>`;
                }
                return `<div class="gchat-file-link">📎 ${escapeHtml(item.name || '附件')}</div>`;
            }).join('');
            return `<div class="gchat-media-wrap">${parts}</div>`;
        }

        function gchatDisplaySender(m) {
            const sender = String(m?.sender || '').trim();
            if (sender && sender !== '成員' && sender !== '未知' && sender !== '我' && !sender.startsWith('使用者 ') && !sender.includes('解析寄件者')) {
                return sender;
            }
            const space = String(m?.spaceDisplayName || '').trim();
            if (space && space !== '對話') return gchatPeerOnlyTitle(space, m);
            return '未知聯絡人';
        }

        /** 私人訊息標題只留對方（去掉「對方、自己」） */
        function gchatIsSelfTitlePart(part) {
            const s = String(part || '').trim();
            if (!s || s === '我') return true;
            const labels = gchatMyLabels || [];
            const tail = (x) => {
                const t = String(x || '').trim();
                const i = t.lastIndexOf('_');
                return i >= 0 && i < t.length - 1 ? t.slice(i + 1).trim() : t;
            };
            const myTail = tail(s);
            for (const lab of labels) {
                if (!lab) continue;
                if (s === lab || s.includes(lab) || lab.includes(s)) return true;
                if (myTail && tail(lab) === myTail) return true;
            }
            return false;
        }

        function gchatPeerOnlyTitle(label, detail) {
            const isDm = !!(detail?.isDm || detail?.spaceType === 'DIRECT_MESSAGE');
            let s = String(label || '').trim();
            if (!isDm) return s || '對話';
            if (/[、,]/.test(s)) {
                const parts = s.split(/[、,]/).map(x => x.trim()).filter(Boolean);
                const others = parts.filter(p => !gchatIsSelfTitlePart(p));
                s = others[0] || parts[0] || s;
            } else if (gchatIsSelfTitlePart(s)) {
                s = '';
            }
            if (!s) {
                // 從對話串找第一個非本人寄件者
                const thread = Array.isArray(detail?.__thread) ? detail.__thread : null;
                // fallback: detail.sender 若不是我
                const sender = String(detail?.sender || '').trim();
                if (sender && sender !== '我' && !gchatIsSelfTitlePart(sender)) s = sender;
            }
            return s || '私人訊息';
        }

        function gchatConversationTitle(detail) {
            const isDm = !!(detail?.isDm || detail?.spaceType === 'DIRECT_MESSAGE');
            const space = String(detail?.spaceDisplayName || '').trim();
            if (isDm) return gchatPeerOnlyTitle(space, detail);
            return space || detail?.sender || '對話';
        }

        function setGchatListMessages(messages) {
            gchatListMessages = Array.isArray(messages) ? messages : [];
        }

        function pinnedUnreadForContact(contact) {
            const userName = String(contact?.userName || '').trim();
            return userName ? (Number(gchatPinnedUnread.contacts?.[userName]) || 0) : 0;
        }

        function pinnedUnreadForSpace(space) {
            const spaceName = String(space?.spaceName || '').trim();
            return spaceName ? (Number(gchatPinnedUnread.spaces?.[spaceName]) || 0) : 0;
        }

        function formatGchatPinUnreadBadge(unreadCount) {
            const n = Number(unreadCount) || 0;
            if (n <= 0) return '';
            const label = n > 99 ? '99+' : String(n);
            return `<span class="gchat-pin-chip-badge" aria-label="未讀 ${label} 則">${label}</span>`;
        }

        function isGchatContactPinned(userName) {
            return (gchatPinnedContacts || []).some(x => x.userName === userName);
        }
        function isGchatSpacePinned(spaceName) {
            return (gchatPinnedSpaces || []).some(x => x.spaceName === spaceName);
        }
        function isGchatMessagePinned(m) {
            if (!m) return false;
            if (m.spaceName && isGchatSpacePinned(m.spaceName)) return true;
            if (m.senderName && isGchatContactPinned(m.senderName)) return true;
            return false;
        }
        function shortGchatPinLabel(label, isDm = false) {
            const s = String(label || '').trim();
            if (!s) return '';
            // 私人：取最後一個 _ 之後（例如 …_林柏秀3009 → 林柏秀3009）
            if (isDm) {
                const idx = s.lastIndexOf('_');
                if (idx >= 0 && idx < s.length - 1) {
                    const tail = s.slice(idx + 1).trim();
                    if (tail) return tail;
                }
            }
            return s;
        }
        function gchatPinLabelForMessage(m) {
            if (m?.isDm) return shortGchatPinLabel(gchatDisplaySender(m), true);
            const space = String(m?.spaceDisplayName || '').trim();
            if (space && space !== '對話') return space;
            return gchatDisplaySender(m);
        }

        function renderGchatPinChipHtml(item, kind, unreadCount = 0) {
            const isDm = !!(item.isDm || kind === 'contact');
            const rawLabel = item.label || item.userName || item.spaceName || '未命名';
            const label = escapeHtml(shortGchatPinLabel(rawLabel, isDm));
            const iconUrl = String(item.iconUrl || '').trim();
            const emoji = String(item.emoji || '').trim();
            let iconHtml = '';
            if (iconUrl && (/^https?:\/\//i.test(iconUrl) || /^data:image\//i.test(iconUrl))) {
                iconHtml = `<img class="gchat-pin-chip-avatar" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
            } else if (emoji) {
                iconHtml = `<span class="gchat-pin-chip-emoji" aria-hidden="true">${escapeHtml(emoji)}</span>`;
            } else {
                iconHtml = `<span class="gchat-pin-chip-emoji is-placeholder" aria-hidden="true">${kind === 'contact' ? '👤' : '💬'}</span>`;
            }
            const unread = Number(unreadCount) || 0;
            const unreadCls = unread > 0 ? ' has-unread' : '';
            const unreadBadge = formatGchatPinUnreadBadge(unread);
            const titleSuffix = unread > 0 ? ` · 未讀 ${unread > 99 ? '99+' : unread} 則` : '';
            const pinFn = kind === 'contact'
                ? `toggleGchatPin(event, 'contact', decodeURIComponent('${encodeURIComponent(item.userName || '')}'), decodeURIComponent('${encodeURIComponent(shortGchatPinLabel(rawLabel, true))}'), decodeURIComponent('${encodeURIComponent(item.email || '')}'))`
                : `toggleGchatPin(event, 'space', decodeURIComponent('${encodeURIComponent(item.spaceName || '')}'), decodeURIComponent('${encodeURIComponent(shortGchatPinLabel(rawLabel, !!item.isDm))}'), '', decodeURIComponent('${encodeURIComponent(item.spaceType || '')}'), '${item.isDm ? '1' : '0'}')`;
            const openFn = kind === 'contact'
                ? `openGchatContact(decodeURIComponent('${encodeURIComponent(item.userName || '')}'), decodeURIComponent('${encodeURIComponent(shortGchatPinLabel(rawLabel, true))}'), decodeURIComponent('${encodeURIComponent(item.spaceName || '')}'))`
                : `openGchatSpace(decodeURIComponent('${encodeURIComponent(item.spaceName || '')}'), decodeURIComponent('${encodeURIComponent(item.label || '')}'), decodeURIComponent('${encodeURIComponent(item.spaceType || '')}'), '${item.isDm ? '1' : '0'}')`;
            return `
                <button type="button" class="gchat-pin-chip${unreadCls}" title="開啟 ${label}${titleSuffix}" onclick="${openFn}">
                    ${unreadBadge}
                    ${iconHtml}
                    <span class="gchat-pin-chip-label">${label}</span>
                    <span role="button" tabindex="0" class="gchat-pin-btn is-on" title="取消置頂" onclick="${pinFn}">★</span>
                </button>`;
        }

        function renderGchatPinItemHtml(item, { pinned, kind }) {
            const label = escapeHtml(item.label || item.userName || item.spaceName || '未命名');
            const hint = escapeHtml(item.hint || item.email || (item.isDm ? '私人' : (kind === 'space' ? '群組' : '聯絡人')));
            const pinOn = pinned ? 'is-on' : '';
            const pinTitle = pinned ? '取消置頂' : '置頂';
            const pinChar = pinned ? '★' : '☆';
            const iconUrl = String(item.iconUrl || '').trim()
                || (pinned
                    ? (kind === 'contact'
                        ? (gchatPinnedContacts.find((c) => c.userName === item.userName)?.iconUrl || '')
                        : (gchatPinnedSpaces.find((s) => s.spaceName === item.spaceName)?.iconUrl || ''))
                    : '');
            const emoji = String(item.emoji || '').trim()
                || (pinned
                    ? (kind === 'contact'
                        ? (gchatPinnedContacts.find((c) => c.userName === item.userName)?.emoji || '')
                        : (gchatPinnedSpaces.find((s) => s.spaceName === item.spaceName)?.emoji || ''))
                    : '');
            let iconPrefix = '';
            if (iconUrl && (/^https?:\/\//i.test(iconUrl) || /^data:image\//i.test(iconUrl))) {
                iconPrefix = `<img class="gchat-pin-chip-avatar" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" /> `;
            } else if (emoji) {
                iconPrefix = `<span class="gchat-pin-chip-emoji">${escapeHtml(emoji)}</span> `;
            }
            let openFn = '';
            let pinFn = '';
            if (kind === 'contact') {
                const u = encodeURIComponent(item.userName || '');
                const l = encodeURIComponent(item.label || '');
                const e = encodeURIComponent(item.email || '');
                const sn = encodeURIComponent(item.spaceName || '');
                openFn = `openGchatContact(decodeURIComponent('${u}'), decodeURIComponent('${l}'), decodeURIComponent('${sn}'))`;
                pinFn = `toggleGchatPin(event, 'contact', decodeURIComponent('${u}'), decodeURIComponent('${l}'), decodeURIComponent('${e}'))`;
            } else {
                const s = encodeURIComponent(item.spaceName || '');
                const l = encodeURIComponent(item.label || '');
                const t = encodeURIComponent(item.spaceType || '');
                const dm = item.isDm ? '1' : '0';
                openFn = `openGchatSpace(decodeURIComponent('${s}'), decodeURIComponent('${l}'), decodeURIComponent('${t}'), '${dm}')`;
                pinFn = `toggleGchatPin(event, 'space', decodeURIComponent('${s}'), decodeURIComponent('${l}'), '', decodeURIComponent('${t}'), '${dm}')`;
            }
            return `
                <div class="gchat-pin-item" onclick="${openFn}">
                    <div class="gchat-pin-main">
                        <div class="gchat-pin-label">${iconPrefix}${label}</div>
                        <div class="gchat-pin-hint">${hint}</div>
                    </div>
                    <button type="button" class="gchat-pin-btn ${pinOn}" title="${pinTitle}" onclick="${pinFn}">${pinChar}</button>
                </div>`;
        }

        function renderGchatPinnedBlock() {
            const box = document.getElementById('gchat-pinned-block');
            if (!box) return;
            const contacts = gchatPinnedContacts || [];
            const spaces = gchatPinnedSpaces || [];
            if (!contacts.length && !spaces.length) {
                box.innerHTML = '';
                return;
            }
            let html = `<div class="gchat-sec-title">置頂</div><div class="gchat-pin-chips">`;
            html += contacts.map(c => renderGchatPinChipHtml(c, 'contact', pinnedUnreadForContact(c))).join('');
            html += spaces.map(s => renderGchatPinChipHtml(s, 'space', pinnedUnreadForSpace(s))).join('');
            html += `</div>`;
            box.innerHTML = html;
        }

        function filterGchatListMessages(messages) {
            // 已置頂且已讀的歷史對話改由上方芯片進入，避免擠壓未讀
            return (messages || []).filter(m => {
                if (!m?.isRead) return true;
                return !isGchatMessagePinned(m);
            });
        }

        function onGchatSearchInput() {
            const input = document.getElementById('gchat-search-input');
            const q = String(input?.value || '').trim();
            clearTimeout(gchatSearchTimer);
            if (!q) {
                const box = document.getElementById('gchat-search-results');
                if (box) {
                    box.hidden = true;
                    box.innerHTML = '';
                }
                return;
            }
            gchatSearchTimer = setTimeout(() => runGchatSearch(q), 280);
        }

        async function runGchatSearch(query) {
            const box = document.getElementById('gchat-search-results');
            if (!box) return;
            box.hidden = false;
            box.innerHTML = `<div class="gchat-sec-title">搜尋中…</div>`;
            const res = await window.api.gchatSearch?.({ query });
            if (!res?.success) {
                box.innerHTML = `<div class="loading">${escapeHtml(res?.error || '搜尋失敗')}</div>`;
                return;
            }
            const contacts = res.contacts || [];
            const spaces = res.spaces || [];
            if (!contacts.length && !spaces.length) {
                box.innerHTML = `<div class="loading">找不到「${escapeHtml(query)}」</div>`;
                return;
            }
            let html = '';
            if (contacts.length) {
                html += `<div class="gchat-sec-title">聯絡人</div>`;
                html += contacts.map(c => renderGchatPinItemHtml(c, {
                    pinned: isGchatContactPinned(c.userName),
                    kind: 'contact'
                })).join('');
            }
            if (spaces.length) {
                html += `<div class="gchat-sec-title">群組／空間</div>`;
                html += spaces.map(s => renderGchatPinItemHtml(s, {
                    pinned: isGchatSpacePinned(s.spaceName),
                    kind: 'space'
                })).join('');
            }
            box.innerHTML = html;
        }

        async function toggleGchatPin(event, kind, key, label = '', email = '', spaceType = '', isDm = '0') {
            event?.stopPropagation?.();
            event?.preventDefault?.();
            const payload = kind === 'contact'
                ? { kind: 'contact', userName: key, label, email }
                : { kind: 'space', spaceName: key, label, spaceType, isDm: isDm === '1' || isDm === true };
            const res = await window.api.gchatPinToggle?.(payload);
            if (!res?.success) {
                alert(res?.error || '置頂失敗');
                return;
            }
            applyGchatIdentityFromRes(res);
            if (Array.isArray(res.messages)) paintGchatList(res.messages);
            else renderGchatPinnedBlock();
            const input = document.getElementById('gchat-search-input');
            if (input?.value?.trim()) runGchatSearch(input.value.trim());
        }

        function applyOpenSpaceResult(res, { fromCache } = {}) {
            if (!res?.success || !res.detail) return false;
            applyGchatIdentityFromRes(res);
            currentGchatContext = res.detail;
            rememberGchatUiPacket(res.detail, res.thread || [res.detail]);
            syncGchatViewing();
            renderGchatModalBody(res.detail, res.thread || [res.detail], {
                fromCache: fromCache != null ? fromCache : !!res.fromCache
            });
            return true;
        }

        let gchatOpenToken = 0;
        let gchatOpenPending = null;

        function gchatComposerDraftSnapshot() {
            const editor = document.getElementById('gchat-reply-text');
            return {
                html: editor ? editor.innerHTML : '',
                focused: document.activeElement === editor,
                attachments: [...(gchatPendingAttachments || [])],
                replyTarget: gchatReplyTarget ? { ...gchatReplyTarget } : null,
                replyInThread: !!document.getElementById('gchat-reply-in-thread')?.checked
            };
        }

        function restoreGchatComposerDraft(snap) {
            if (!snap) return;
            const editor = document.getElementById('gchat-reply-text');
            if (editor && snap.html) editor.innerHTML = snap.html;
            gchatPendingAttachments = Array.isArray(snap.attachments) ? snap.attachments : [];
            renderGchatAttachPreview?.();
            gchatReplyTarget = snap.replyTarget || null;
            const chk = document.getElementById('gchat-reply-in-thread');
            if (chk) chk.checked = !!snap.replyInThread;
            updateGchatReplyTargetChip?.();
            if (snap.focused && editor) {
                editor.focus();
                try {
                    const range = document.createRange();
                    range.selectNodeContents(editor);
                    range.collapse(false);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                } catch (_) {}
            }
        }

        function captureGchatScrollAnchor(scroll) {
            if (!scroll) return { mode: 'bottom' };
            const gap = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
            if (gap < 140) return { mode: 'bottom' };
            const bubbles = [...scroll.querySelectorAll('[data-msg-name]')];
            for (const el of bubbles) {
                const bottom = el.offsetTop + el.offsetHeight;
                if (bottom > scroll.scrollTop + 8) {
                    return {
                        mode: 'msg',
                        name: el.dataset.msgName || '',
                        offset: scroll.scrollTop - el.offsetTop,
                        scrollTop: scroll.scrollTop
                    };
                }
            }
            return { mode: 'pos', scrollTop: scroll.scrollTop };
        }

        function restoreGchatScrollAnchor(scroll, anchor) {
            if (!scroll) return;
            if (!anchor || anchor.mode === 'bottom') {
                if (anchor?.mode === 'bottom') {
                    scroll.scrollTop = scroll.scrollHeight;
                }
                return;
            }
            if (anchor.mode === 'msg' && anchor.name) {
                const el = [...scroll.querySelectorAll('[data-msg-name]')]
                    .find(n => n.dataset.msgName === anchor.name);
                if (el) {
                    scroll.scrollTop = Math.max(0, el.offsetTop + (Number(anchor.offset) || 0));
                    return;
                }
            }
            if (typeof anchor.scrollTop === 'number') {
                const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
                scroll.scrollTop = Math.min(anchor.scrollTop, max);
            }
        }

        function stabilizeGchatScrollRestore(scroll, anchor) {
            if (!scroll || !anchor) return;
            const run = () => restoreGchatScrollAnchor(scroll, anchor);
            requestAnimationFrame(() => requestAnimationFrame(run));
            [60, 150, 320, 600].forEach((ms) => setTimeout(run, ms));
        }

        function isGchatThreadNearBottom(scroll, gapPx = 140) {
            if (!scroll) return true;
            const gap = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
            return gap < gapPx;
        }

        function paintGchatThreadHistory(detail, thread, { fromCache, historyLoading, preserveScroll } = {}) {
            const scroll = document.getElementById('gchat-thread-scroll');
            const title = document.querySelector('#modal-body .modal-title');
            const meta = document.querySelector('#modal-body .mail-meta');
            if (title) title.textContent = `💬 ${gchatConversationTitle(detail)}`;
            if (meta) {
                if (historyLoading) {
                    meta.textContent = '歷史載入中…可先輸入訊息';
                } else {
                    const peer = gchatConversationTitle(detail);
                    const sender = String(detail?.sender || '').trim();
                    const who = (sender && sender !== '我' && !gchatIsSelfTitlePart(sender)) ? sender : peer;
                    meta.textContent = `來自 ${who}${fromCache ? '' : ' · 剛更新歷史'}`;
                }
            }
            if (!scroll) return;
            if (historyLoading) {
                scroll.innerHTML = `<div class="loading" style="padding:16px;">載入歷史訊息…</div>`;
                return;
            }
            const scrollAnchor = preserveScroll ? captureGchatScrollAnchor(scroll) : null;
            const list = Array.isArray(thread) && thread.length ? thread : [];
            scroll.innerHTML = list.length
                ? list.map(m => renderGchatBubbleHtml(m)).join('')
                : `<div class="loading" style="padding:16px;opacity:.75;">尚無訊息，打個招呼吧</div>`;
            bindGchatBubbleReplyButtons(scroll);
            if (preserveScroll) {
                stabilizeGchatScrollRestore(scroll, scrollAnchor);
            } else {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    scroll.scrollTop = scroll.scrollHeight;
                }));
            }
        }

        /** 歷史回來時更新畫面，保留使用者已輸入的草稿 */
        function mergeOpenSpaceIntoComposer(res, { fromCache } = {}) {
            if (!res?.success || !res.detail) return false;
            applyGchatIdentityFromRes(res);
            const hadComposer = !!document.getElementById('gchat-reply-box');
            const snap = hadComposer ? gchatComposerDraftSnapshot() : null;
            currentGchatContext = res.detail;
            if (!res.pendingHistory) {
                rememberGchatUiPacket(res.detail, res.thread || [res.detail]);
            }
            syncGchatViewing();
            if (hadComposer && document.getElementById('gchat-thread-scroll')) {
                paintGchatThreadHistory(res.detail, res.thread || [], {
                    fromCache: fromCache != null ? fromCache : !!res.fromCache,
                    historyLoading: !!res.pendingHistory,
                    preserveScroll: !res.pendingHistory
                });
                restoreGchatComposerDraft(snap);
            } else {
                renderGchatModalBody(res.detail, res.thread || [], {
                    fromCache: fromCache != null ? fromCache : !!res.fromCache,
                    historyLoading: !!res.pendingHistory
                });
                restoreGchatComposerDraft(snap);
            }
            return true;
        }

        function openGchatComposerShell({ label, isDm, spaceName, spaceType, userName }) {
            const shell = {
                name: '',
                spaceName: spaceName || '',
                spaceDisplayName: label || (isDm ? '私人訊息' : '對話'),
                sender: label || '',
                senderName: userName || '',
                isDm: !!isDm,
                spaceType: spaceType || (isDm ? 'DIRECT_MESSAGE' : ''),
                snippet: '',
                text: '',
                threadName: '',
                media: []
            };
            currentGchatContext = shell;
            if (shell.spaceName) syncGchatViewing();
            renderGchatModalBody(shell, [], { historyLoading: true });
            return shell;
        }


        // ========== 【FEATURE: gchat】Little Reply ==========
        async function loadGchatSpaceInBackground(payload, openToken) {
            const run = (async () => {
                // 1) 先解析空間（可盡快送出），不撈歷史
                const quick = await window.api.gchatOpenSpace?.({ ...payload, deferHistory: true });
                if (openToken !== gchatOpenToken) return quick;
                if (!quick?.success) {
                    const meta = document.querySelector('#modal-body .mail-meta');
                    if (meta) meta.textContent = quick?.error || '無法開啟對話';
                    const scroll = document.getElementById('gchat-thread-scroll');
                    if (scroll) {
                        scroll.innerHTML = `<div class="loading" style="padding:16px;">${escapeHtml(quick?.error || '無法開啟對話')}</div>`;
                    }
                    return quick;
                }
                mergeOpenSpaceIntoComposer(quick, { fromCache: !!quick.fromCache });
                if (quick.fromCache && !quick.pendingHistory) return quick;

                // 2) 背景撈歷史，完成後填入（保留草稿）
                const full = await window.api.gchatOpenSpace?.({
                    ...payload,
                    spaceName: quick.detail?.spaceName || payload.spaceName,
                    deferHistory: false
                });
                if (openToken !== gchatOpenToken) return full;
                if (!full?.success) {
                    const meta = document.querySelector('#modal-body .mail-meta');
                    if (meta) meta.textContent = full?.error || '歷史載入失敗（仍可發送）';
                    return full;
                }
                mergeOpenSpaceIntoComposer(full, { fromCache: !!full.fromCache });
                return full;
            })();
            gchatOpenPending = run.finally(() => {
                if (gchatOpenPending === run) gchatOpenPending = null;
            });
            return gchatOpenPending;
        }

        /** 點群組／空間名稱 → Message Box（整個空間對話，不鎖定 inbox 那一則） */
        async function openGchatMessageBoxFromList(spaceName, label = '', spaceType = '', isDm = '0') {
            if (!spaceName) return;
            const dm = isDm === '1' || isDm === true;
            try {
                document.getElementById('detail-modal').style.display = 'none';
            } catch (_) {}
            currentGchatContext = null;
            window.api.gchatOpenSpace?.({
                spaceName, label, spaceType, isDm: dm, deferHistory: false
            }).catch(() => {});
            await window.api.gchatCompactOpen?.({
                messageName: '',
                spaceName,
                isDm: dm,
                title: label || '',
                spaceType: spaceType || '',
                focusThread: false
            });
        }

        /** 點訊息列 → Focus Thread（群組討論串）或捲到該則（私人） */
        async function openGchatFocusFromList(name, spaceName = '', isDm = '', threadName = '', snippet = '') {
            if (!name) return;
            const dm = isDm === '1' || isDm === true;
            const th = String(threadName || '').trim();
            const hasApiThread = !dm && /\/threads\//.test(th);
            try {
                document.getElementById('detail-modal').style.display = 'none';
            } catch (_) {}
            currentGchatContext = null;
            if (hasApiThread) {
                await window.api.gchatCompactOpen?.({
                    messageName: name,
                    spaceName: spaceName || '',
                    isDm: false,
                    focusThread: true,
                    threadName: th,
                    focusRootText: String(snippet || '').trim(),
                    rootMessageName: name,
                    title: ''
                });
                return;
            }
            await window.api.gchatCompactOpen?.({
                messageName: name,
                spaceName: spaceName || '',
                isDm: dm,
                focusThread: false,
                jumpToMessage: true
            });
        }

        /** Little Reply 一律開泡泡訊息框（可最小化），不再用主視窗 modal */
        async function openGchatBubble(name, spaceName = '', isDm = '', title = '', userName = '', iconUrl = '', emoji = '') {
            if (!name && !spaceName && !userName) return;
            try {
                document.getElementById('detail-modal').style.display = 'none';
            } catch (_) {}
            currentGchatContext = null;
            await window.api.gchatCompactOpen?.({
                messageName: name || '',
                spaceName: spaceName || '',
                isDm: isDm === '1' || isDm === true,
                title: title || '',
                userName: userName || '',
                iconUrl: iconUrl || '',
                emoji: emoji || ''
            });
        }

        async function openGchatContact(userName, label = '', spaceName = '') {
            if (!userName) return;
            const pinned = (gchatPinnedContacts || []).find(c => c.userName === userName);
            const sn = spaceName || pinned?.spaceName || '';
            const iconUrl = pinned?.iconUrl || '';
            const emoji = pinned?.emoji || '';
            const uiHit = sn ? findGchatUiPacket('', sn, '1') : null;
            if (uiHit?.detail?.name) {
                await openGchatBubble(uiHit.detail.name, sn, '1', label, userName, iconUrl, emoji);
                return;
            }
            // 立即開泡泡；空間解析與歷史由泡泡 load() 處理（避免主視窗等 API）
            await openGchatBubble('', sn, '1', label, userName, iconUrl, emoji);
        }

        async function openGchatSpace(spaceName, label = '', spaceType = '', isDm = '0') {
            if (!spaceName) return;
            const dm = isDm === '1' || isDm === true;
            const pinned = (gchatPinnedSpaces || []).find(s => s.spaceName === spaceName);
            const iconUrl = pinned?.iconUrl || '';
            const emoji = pinned?.emoji || '';
            const uiHit = findGchatUiPacket('', spaceName, dm ? '1' : '0');
            if (uiHit?.detail?.name) {
                await openGchatBubble(uiHit.detail.name, spaceName, dm ? '1' : '0', label, '', iconUrl, emoji);
                return;
            }
            await openGchatBubble('', spaceName, dm ? '1' : '0', label, '', iconUrl, emoji);
        }

        function paintGchatList(messages) {
            setGchatListMessages(messages);
            renderGchatPinnedBlock();
            const list = document.getElementById('gchat-list');
            if (!list) return;
            const shown = filterGchatListMessages(gchatListMessages);
            list.innerHTML = shown.length
                ? shown.map(renderGchatItem).join('')
                : `<div class="loading">🎉 目前沒有未讀／今日追蹤<br><span style="font-size:0.9em;opacity:.8;">置頂對話在上方芯片，點名稱即可開啟</span></div>`;
        }

        function renderGchatItem(m) {
            const key = encodeURIComponent(m.name || '');
            const ct = encodeURIComponent(m.createTime || '');
            const tn = encodeURIComponent(m.threadName || '');
            const sn = encodeURIComponent(m.spaceName || '');
            const pl = encodeURIComponent(gchatPinLabelForMessage(m));
            const st = encodeURIComponent(m.spaceType || '');
            const isRead = !!m.isRead;
            const who = gchatDisplaySender(m);
            const pinned = isGchatMessagePinned(m);
            const unreadN = Number(m.unreadCount || 0);
            const unreadHint = !isRead && unreadN > 1 ? ` · 未讀×${unreadN}` : '';
            const lead = isRead
                ? `<span class="gchat-read-icon" title="今日已讀">✓</span>`
                : `<input type="checkbox" class="mail-checkbox" title="標示為已讀"
                            onclick="markGchatRead(event, decodeURIComponent('${key}'), decodeURIComponent('${ct}'), decodeURIComponent('${tn}'), decodeURIComponent('${sn}'))">`;
            const sp = encodeURIComponent(m.snippet || '');
            const spaceLabel = escapeHtml(m.spaceDisplayName || who || '對話');
            const metaTag = `${m.isDm ? ' · 私人' : (m.mentionedMe ? ' · @我' : '')}${isRead ? ' · 已讀' : ''}${unreadHint}`;
            const pinBtn = `<button type="button" class="gchat-pin-btn ${pinned ? 'is-on' : ''}" title="${pinned ? '取消置頂' : '置頂此對話'}"
                onclick="toggleGchatPinFromMessage(event, decodeURIComponent('${sn}'), decodeURIComponent('${pl}'), decodeURIComponent('${st}'), '${m.isDm ? '1' : '0'}')">${pinned ? '★' : '☆'}</button>`;
            const iconUrl = String(m.iconUrl || '').trim();
            const iconEmoji = String(m.emoji || '').trim();
            let iconHtml = '';
            if (iconUrl && (/^https?:\/\//i.test(iconUrl) || /^data:image\//i.test(iconUrl))) {
                iconHtml = `<img class="mail-icon is-avatar" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
            } else if (iconEmoji) {
                iconHtml = `<div class="mail-icon is-emoji" aria-hidden="true">${escapeHtml(iconEmoji)}</div>`;
            } else {
                iconHtml = `<div class="mail-icon">${escapeHtml(who.charAt(0).toUpperCase())}</div>`;
            }
            return `
                <div class="list-item mail-item ${isRead ? 'gchat-item-read' : ''}">
                    <div class="mail-row">
                        ${lead}
                        <div class="mail-content">
                            <div class="mail-header">
                                ${iconHtml}
                                <span class="mail-from">${escapeHtml(who)}</span>
                            </div>
                            <div class="mail-subject gchat-open-space" title="開啟對話（Message Box）"
                                onclick="event.stopPropagation(); openGchatMessageBoxFromList(decodeURIComponent('${sn}'), decodeURIComponent('${pl}'), decodeURIComponent('${st}'), ${m.isDm ? "'1'" : "'0'"})">${spaceLabel}${metaTag}</div>
                            <div class="mail-snippet gchat-open-message" title="開啟此則訊息（Focus Thread）"
                                onclick="event.stopPropagation(); openGchatFocusFromList(decodeURIComponent('${key}'), decodeURIComponent('${sn}'), ${m.isDm ? "'1'" : "'0'"}, decodeURIComponent('${tn}'), decodeURIComponent('${sp}'))">${escapeHtml(m.snippet || '（無預覽文字）')}${m.createTimeLabel ? ' · ' + escapeHtml(m.createTimeLabel) : ''}</div>
                        </div>
                        ${pinBtn}
                    </div>
                </div>`;
        }

        async function toggleGchatPinFromMessage(event, spaceName, label = '', spaceType = '', isDm = '0') {
            event?.stopPropagation?.();
            event?.preventDefault?.();
            if (!spaceName) return;
            const res = await window.api.gchatPinToggle?.({
                kind: 'space',
                spaceName,
                label: label || spaceName || '對話',
                spaceType: spaceType || (isDm === '1' ? 'DIRECT_MESSAGE' : ''),
                isDm: isDm === '1' || isDm === true
            });
            if (!res?.success) {
                alert(res?.error || '置頂失敗');
                return;
            }
            applyGchatIdentityFromRes(res);
            if (Array.isArray(res.messages)) paintGchatList(res.messages);
            else renderGchatPinnedBlock();
        }

        async function loadGchat({ silent } = {}) {
            const list = document.getElementById('gchat-list');
            if (!list) return;
            if (!(await ensureFeatureAuthorized('gchat'))) {
                if (!silent) paintFeatureAuthGate(list, 'gchat', 'Little Reply');
                return;
            }
            // [Important] 不再自行 Poll Server；背景同步由 main SyncScheduler 負責
            if (!silent) list.innerHTML = `<div class="loading">讀取未讀 Chat…</div>`;
            const res = await window.api.gchatList();
            updateGchatHint(res);
            applyGchatIdentityFromRes(res);
            setGchatListMessages(res.messages || []);
            renderGchatPinnedBlock();
            if (res?.offline && res?.success) {
                paintGchatList(res.messages || []);
                refreshOpenGchatThread();
                return;
            }
            if (!res?.success) {
                if (res?.needsApi || res?.needsReauth || res?.featureScopeMissing || res?.needsAuth || res?.authRevoked) {
                    list.innerHTML = `
                        <div class="loading" style="text-align:left;line-height:1.6;">
                            ${escapeHtml(res.error || '尚未就緒')}<br><br>
                            <button class="btn-primary" onclick="event.stopPropagation(); openGchatApiSetup()">啟用 Chat API</button>
                            <button class="btn-ghost" style="margin-top:8px;" onclick="event.stopPropagation(); authorizeFeature('gchat')">授權 Google Chat</button>
                        </div>`;
                } else {
                    list.innerHTML = `<div class="loading">${escapeHtml(res?.error || '讀取失敗')}</div>`;
                }
                return;
            }
            const messages = res.messages || [];
            if (!messages.length && !(gchatPinnedContacts || []).length && !(gchatPinnedSpaces || []).length) {
                list.innerHTML = `<div class="loading">🎉 目前沒有未讀／今日追蹤<br><span style="font-size:0.9em;opacity:.8;">可用上方搜尋找聯絡人／群組並置頂</span></div>`;
            } else {
                paintGchatList(messages);
            }
            refreshOpenGchatThread();
        }

        async function markGchatRead(event, name, createTime = '', threadName = '', spaceName = '') {
            event.stopPropagation();
            event.preventDefault();
            const res = await window.api.gchatMarkRead({ name, createTime, threadName, spaceName });
            if (res?.success) {
                updateGchatHint(res);
                applyGchatIdentityFromRes(res);
                paintGchatList(res.messages || []);
            } else if (res?.error) {
                alert(res.error);
            }
        }

        const GCHAT_EMOJI_LIST = ['😀','😊','😂','🥰','😍','🤔','👍','👏','🙏','🎉','❤️','🔥','✨','☕','📌','✅','😅','😢','💪','🙌','😁','😉','😎','🤝','💯'];

        function renderGchatPlainText(text) {
            const raw = String(text || '');
            const urlRe = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
            const chunks = [];
            let last = 0;
            let match;
            while ((match = urlRe.exec(raw)) !== null) {
                if (match.index > last) chunks.push({ type: 'text', value: raw.slice(last, match.index) });
                let url = match[0];
                let trailing = '';
                // 句尾標點通常不屬於網址
                while (/[.,;:!?)]$/.test(url)) {
                    trailing = url.slice(-1) + trailing;
                    url = url.slice(0, -1);
                }
                if (url) chunks.push({ type: 'url', value: url });
                if (trailing) chunks.push({ type: 'text', value: trailing });
                last = match.index + match[0].length;
            }
            if (last < raw.length) chunks.push({ type: 'text', value: raw.slice(last) });

            return chunks.map((part) => {
                if (part.type === 'url') {
                    const u = escapeHtml(part.value);
                    return `<a class="gchat-text-link" href="${u}" title="${u}" rel="noopener noreferrer" onclick="event.preventDefault();event.stopPropagation();window.api.openExternal(this.getAttribute('href'))">${u}</a>`;
                }
                let s = escapeHtml(part.value);
                s = s.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
                s = s.replace(/_([^_\n]+)_/g, '<em>$1</em>');
                return s;
            }).join('');
        }

        function linkifyEscapedGchatSegment(escapedText) {
            const raw = String(escapedText || '');
            if (!raw) return '';
            const urlRe = /https?:\/\/[^\s<>"'{}|\\^`\[\]]+/gi;
            const chunks = [];
            let last = 0;
            let match;
            while ((match = urlRe.exec(raw)) !== null) {
                if (match.index > last) chunks.push({ type: 'text', value: raw.slice(last, match.index) });
                let url = match[0];
                let trailing = '';
                while (/[.,;:!?)]$/.test(url)) {
                    trailing = url.slice(-1) + trailing;
                    url = url.slice(0, -1);
                }
                if (url) chunks.push({ type: 'url', value: url });
                if (trailing) chunks.push({ type: 'text', value: trailing });
                last = match.index + match[0].length;
            }
            if (last < raw.length) chunks.push({ type: 'text', value: raw.slice(last) });
            if (!chunks.length) return raw;
            return chunks.map((part) => {
                if (part.type === 'url') {
                    const u = part.value;
                    return `<a class="gchat-text-link" href="${u}" title="${u}" rel="noopener noreferrer" onclick="event.preventDefault();event.stopPropagation();window.api.openExternal(this.getAttribute('href'))">${u}</a>`;
                }
                return part.value;
            }).join('');
        }

        function renderGchatCardLinksHtml(links) {
            return (links || []).map((l) => {
                const u = String(l?.url || '').trim();
                if (!/^https?:\/\//i.test(u)) return '';
                const label = escapeHtml(String(l.text || u).trim() || u);
                const safe = escapeHtml(u);
                return `<a class="gchat-msg-card-btn gchat-card-link" href="${safe}" title="${safe}" rel="noopener noreferrer" onclick="event.preventDefault();event.stopPropagation();window.api.openExternal(this.getAttribute('href'))">${label}</a>`;
            }).filter(Boolean).join('');
        }

        function renderGchatMessageBodyHtml(m) {
            if (m?.cardHtml) {
                const extra = (m.textHtml && !String(m.textHtml).includes('gchat-msg-card'))
                    ? String(m.textHtml).split(/(<img\b[^>]*>|<a\b[^>]*>[\s\S]*?<\/a>)/gi).map((part) => {
                        if (/^<(img|a)\b/i.test(part)) return part;
                        return linkifyEscapedGchatSegment(part);
                    }).join('')
                    : '';
                return `${extra || ''}${m.cardHtml}`;
            }
            const links = Array.isArray(m?.cardLinks) ? m.cardLinks : [];
            let html = '';
            if (m?.textHtml) {
                html = String(m.textHtml).split(/(<img\b[^>]*>|<a\b[^>]*>[\s\S]*?<\/a>)/gi).map((part) => {
                    if (/^<(img|a)\b/i.test(part)) return part;
                    return linkifyEscapedGchatSegment(part);
                }).join('');
            } else if (m?.text) {
                html = renderGchatPlainText(m.text);
            }
            if (!links.length) return html;
            if (html.includes('gchat-msg-card')) return html;
            const missing = links.filter((l) => {
                const u = String(l?.url || '').trim();
                return u && !html.includes(u) && !html.includes(escapeHtml(u));
            });
            if (!missing.length) return html;
            const block = `<div class="gchat-msg-card-actions">${renderGchatCardLinksHtml(missing)}</div>`;
            return html ? `${html}${block}` : block;
        }

        function gchatEditorCmd(cmd) {
            const editor = document.getElementById('gchat-reply-text');
            if (!editor) return;
            editor.focus();
            document.execCommand(cmd, false, null);
            syncGchatEditorToolbarState();
        }

        function syncGchatEditorToolbarState() {
            const boldBtn = document.getElementById('gchat-btn-bold');
            const italicBtn = document.getElementById('gchat-btn-italic');
            let boldOn = false;
            let italicOn = false;
            try {
                boldOn = !!document.queryCommandState('bold');
                italicOn = !!document.queryCommandState('italic');
            } catch (_) {}
            if (boldBtn) {
                boldBtn.classList.toggle('is-active', boldOn);
                boldBtn.setAttribute('aria-pressed', boldOn ? 'true' : 'false');
            }
            if (italicBtn) {
                italicBtn.classList.toggle('is-active', italicOn);
                italicBtn.setAttribute('aria-pressed', italicOn ? 'true' : 'false');
            }
        }

        function bindGchatEditorToolbarState(editor) {
            if (!editor || editor.dataset.toolbarBound === '1') return;
            editor.dataset.toolbarBound = '1';
            const sync = () => syncGchatEditorToolbarState();
            editor.addEventListener('keyup', sync);
            editor.addEventListener('mouseup', sync);
            editor.addEventListener('focus', sync);
            document.addEventListener('selectionchange', () => {
                if (document.activeElement === editor) sync();
            });
        }

        function gchatEditorColor(color) {
            const editor = document.getElementById('gchat-reply-text');
            if (!editor) return;
            editor.focus();
            document.execCommand('styleWithCSS', false, true);
            document.execCommand('foreColor', false, color);
        }

        function toggleGchatEmojiPicker() {
            const btn = document.querySelector('#gchat-composer-emoji-anchor');
            if (!btn || !window.GchatEmojiPicker) {
                document.getElementById('gchat-emoji-picker')?.classList.toggle('open');
                return;
            }
            if (window.GchatEmojiPicker.isOpen()) {
                window.GchatEmojiPicker.close();
                return;
            }
            window.GchatEmojiPicker.open(btn, {
                onPick: (payload) => {
                    if (payload.unicode) insertGchatEmoji(payload.unicode);
                },
                loadCustom: (opts) => loadGchatCustomEmojisOnce(opts || {})
            });
        }

        function insertGchatEmoji(emoji) {
            const editor = document.getElementById('gchat-reply-text');
            if (!editor) return;
            editor.focus();
            document.execCommand('insertText', false, emoji);
        }

        function buildGchatEmojiPicker() {
            return GCHAT_EMOJI_LIST.map(e =>
                `<button type="button" onclick="insertGchatEmoji('${e}')">${e}</button>`
            ).join('');
        }

        function gchatEditorToChatText(root) {
            if (!root) return '';
            const walk = (node) => {
                if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
                if (node.nodeType !== Node.ELEMENT_NODE) return '';
                const tag = node.tagName.toLowerCase();
                if (tag === 'br') return '\n';
                const inner = [...node.childNodes].map(walk).join('');
                if (tag === 'div' || tag === 'p') return (inner ? `${inner}\n` : '\n');
                if (tag === 'strong' || tag === 'b') return inner ? `*${inner}*` : '';
                if (tag === 'em' || tag === 'i') return inner ? `_${inner}_` : '';
                if (tag === 'span' || tag === 'font') {
                    // Google Chat 不支援文字顏色，保留文字內容
                    return inner;
                }
                return inner;
            };
            return walk(root).replace(/\n{3,}/g, '\n\n').trim();
        }

        function getGchatReplyText() {
            const editor = document.getElementById('gchat-reply-text');
            if (!editor) return '';
            if (editor.isContentEditable) return gchatEditorToChatText(editor);
            return (editor.value || '').trim();
        }

        let gchatPendingAttachments = [];
        let gchatReplySending = false;
        let gchatThreadRefreshBusy = false;
        let gchatApiQuotaBlockedUntil = 0;
        /** 點泡泡「回覆」後的目標訊息（對話串回覆） */
        let gchatReplyTarget = null;

        function gchatReplyIconHtml() {
            return `<svg class="reply-glyph" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>`;
        }

        function markGchatReplyIconsMaterial() {
            /* [Important] 回覆圖示固定用 SVG，不依 Material Symbols */
        }

        function clearGchatReplyTarget() {
            gchatReplyTarget = null;
            const chip = document.getElementById('gchat-reply-target-chip');
            if (chip) {
                chip.classList.remove('is-on');
                chip.querySelector('.chip-preview')?.replaceChildren();
            }
        }

        function updateGchatReplyTargetChip() {
            const chip = document.getElementById('gchat-reply-target-chip');
            if (!chip) return;
            if (!gchatReplyTarget?.messageName) {
                chip.classList.remove('is-on');
                return;
            }
            chip.classList.add('is-on');
            const label = chip.querySelector('.chip-label');
            const preview = chip.querySelector('.chip-preview');
            if (label) label.textContent = `回覆 ${gchatReplyTarget.sender || '此訊息'}`;
            if (preview) preview.textContent = gchatReplyTarget.preview || '';
        }

        function startGchatReplyToMessage(messageName, event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            const el = (event && event.currentTarget && event.currentTarget.closest)
                ? event.currentTarget.closest('.gchat-bubble')
                : null;
            const name = messageName || (el && el.dataset ? el.dataset.msgName : '') || '';
            if (!name || String(name).indexOf('temp-') === 0) return;
            const sender = (el && el.dataset && el.dataset.sender) || '';
            const threadName = (el && el.dataset && el.dataset.threadName) || name;
            const createTime = (el && el.dataset && el.dataset.createTime) || '';
            const lastUpdateTime = (el && el.dataset && el.dataset.lastUpdateTime) || createTime;
            const textEl = el ? el.querySelector('.gchat-text') : null;
            const preview = ((textEl && textEl.innerText) || '').trim().slice(0, 80);
            gchatReplyTarget = {
                messageName: name,
                threadName,
                sender,
                preview,
                createTime,
                lastUpdateTime
            };
            const box = document.getElementById('gchat-reply-in-thread');
            if (box) box.checked = true;
            updateGchatReplyTargetChip();
            const editor = document.getElementById('gchat-reply-text');
            if (editor) editor.focus();
        }

        function renderGchatQuoteHtml(quoted) {
            if (!quoted?.name && !quoted?.text && !quoted?.textHtml && !quoted?.media?.length && !quoted?.forwardFrom) return '';
            const who = escapeHtml(quoted.sender || '引用訊息');
            const forwardHint = quoted.forwardFrom
                ? `<div class="gchat-quote-forward">${escapeHtml(quoted.forwardFrom)}</div>`
                : '';
            let body = '';
            if (quoted.textHtml) {
                body = quoted.textHtml;
            } else if (quoted.text) {
                body = escapeHtml(quoted.text);
            } else if (quoted.media?.length) {
                body = '[附件]';
            } else {
                body = escapeHtml('（無文字）');
            }
            return `<div class="gchat-quote">${forwardHint}<div class="gchat-quote-who">${who}</div>${body}</div>`;
        }

        let gchatCustomEmojiCache = null;
        let gchatCustomEmojiCachePromise = null;
        let gchatCustomEmojiWarning = '';

        function gchatReactionKey(r) {
            if (r?.reactionKey) return r.reactionKey;
            if (r?.customUid) return `custom:${r.customUid}`;
            return r?.unicode || '';
        }

        function loadGchatCustomEmojisOnce({ force = false } = {}) {
            const cachedHasImage = Array.isArray(gchatCustomEmojiCache)
                && gchatCustomEmojiCache.some((e) => e?.imageUrl);
            if (gchatCustomEmojiCache && !force && cachedHasImage) {
                return Promise.resolve({ emojis: gchatCustomEmojiCache, warning: gchatCustomEmojiWarning });
            }
            if (!gchatCustomEmojiCachePromise || force) {
                gchatCustomEmojiCachePromise = window.api.gchatCustomEmojis?.({ force: !!force })
                    .then((res) => {
                        gchatCustomEmojiCache = res?.success ? (res.emojis || []) : [];
                        gchatCustomEmojiWarning = String(
                            res?.warning || res?.error || (res?.quotaBlocked ? '自訂表情 API 配額已滿，請稍後再試' : '')
                        ).trim();
                        return { emojis: gchatCustomEmojiCache, warning: gchatCustomEmojiWarning };
                    })
                    .catch(() => ({ emojis: [], warning: '' }));
            }
            return gchatCustomEmojiCachePromise;
        }

        function buildGchatReactionEmojiHtml(r) {
            const label = escapeHtml(r?.label || r?.unicode || '');
            if (r?.imageUrl) {
                return `<img class="gchat-custom-emoji-img" src="${escapeHtml(r.imageUrl)}" alt="${label}" title="${label}" />`;
            }
            return escapeHtml(r?.unicode || r?.label || '🙂');
        }

        function renderGchatReactionsHtml(m) {
            const name = escapeHtml(m?.name || '');
            if (!name || String(m?.name || '').indexOf('temp-') === 0) return '';
            const list = Array.isArray(m.reactions) ? m.reactions : [];
            const chips = list.map((r) => {
                const count = Number(r.count || 0) || 0;
                const emoji = buildGchatReactionEmojiHtml(r);
                const unicode = r.unicode || '';
                const customUid = r.customUid || '';
                const reactKey = encodeURIComponent(gchatReactionKey(r));
                const mine = r.reactedByMe ? ' is-mine' : '';
                if (!unicode && !customUid) {
                    return `<span class="gchat-react-chip" title="自訂表情">${emoji} ${count}</span>`;
                }
                return `<button type="button" class="gchat-react-chip${mine}" title="再按一次可收回" data-msg-name="${name}" data-react-key="${reactKey}" data-unicode="${encodeURIComponent(unicode)}" data-custom-uid="${escapeHtml(customUid)}" data-mine="${r.reactedByMe ? '1' : '0'}">${emoji} <span class="gchat-react-count">${count}</span></button>`;
            }).join('');
            return `<div class="gchat-reactions" data-msg-name="${name}">
                ${chips}
                <button type="button" class="gchat-react-toggle" title="Icon 回覆" onclick="toggleGchatReactPicker(event, this)">😊</button>
            </div>`;
        }

        function toggleGchatReactPicker(event, btn) {
            event?.stopPropagation?.();
            const wrap = btn?.parentElement;
            const msgName = wrap?.dataset?.msgName || '';
            if (!msgName || !window.GchatEmojiPicker) return;
            if (window.GchatEmojiPicker.isOpen()) {
                window.GchatEmojiPicker.close();
                btn.textContent = '😊';
                btn.title = 'Icon 回覆';
                return;
            }
            window.GchatEmojiPicker.open(btn, {
                onPick: (payload) => {
                    reactGchatMessage(msgName, payload);
                    btn.textContent = '😊';
                    btn.title = 'Icon 回覆';
                },
                loadCustom: (opts) => loadGchatCustomEmojisOnce(opts || {})
            });
            btn.textContent = '✕';
            btn.title = '收合';
        }

        function collapseGchatReactPicker(fromEl) {
            const wrap = fromEl?.closest?.('.gchat-reactions');
            const toggle = wrap?.querySelector('.gchat-react-toggle');
            window.GchatEmojiPicker?.close?.();
            if (toggle) {
                toggle.textContent = '😊';
                toggle.title = 'Icon 回覆';
            }
        }

        function readGchatReactPayload(btn) {
            const customUid = String(btn?.dataset?.customUid || '').trim();
            let unicode = '';
            try { unicode = decodeURIComponent(btn.dataset.unicode || ''); } catch (_) {}
            unicode = String(unicode).normalize('NFC');
            const reactionKey = customUid ? `custom:${customUid}` : unicode;
            return { unicode, customUid, reactionKey };
        }

        function findGchatReactionChip(wrap, payload) {
            if (!wrap || !payload?.reactionKey) return null;
            const keyEnc = encodeURIComponent(payload.reactionKey);
            return [...wrap.querySelectorAll('.gchat-react-chip')].find((b) => {
                if (b.dataset.reactKey === keyEnc) return true;
                const p = readGchatReactPayload(b);
                return p.reactionKey === payload.reactionKey;
            }) || null;
        }

        function gchatChipCount(chip) {
            const span = chip?.querySelector?.('.gchat-react-count');
            if (span) return parseInt(String(span.textContent).replace(/[^\d]/g, ''), 10) || 0;
            return parseInt(String(chip?.textContent).replace(/[^\d]/g, ''), 10) || 0;
        }

        function setGchatChipCount(chip, n) {
            const span = chip?.querySelector?.('.gchat-react-count');
            if (span) span.textContent = String(n);
            else if (chip) chip.textContent = `${chip.textContent.replace(/\s*\d+\s*$/, '')} ${n}`;
        }

        function applyGchatReactionDom(wrap, payload, action, emojiHtml = '') {
            if (!wrap || !payload?.reactionKey) return;
            const chip = findGchatReactionChip(wrap, payload);
            if (action === 'remove') {
                if (!chip) return;
                const n = gchatChipCount(chip);
                if (n <= 1) chip.remove();
                else {
                    setGchatChipCount(chip, n - 1);
                    chip.dataset.mine = '0';
                    chip.classList.remove('is-mine');
                }
                return;
            }
            if (chip) {
                setGchatChipCount(chip, gchatChipCount(chip) + 1);
                chip.dataset.mine = '1';
                chip.classList.add('is-mine');
                return;
            }
            const msgName = wrap.dataset.msgName || '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'gchat-react-chip is-mine';
            btn.title = '再按一次可收回';
            btn.dataset.msgName = msgName;
            btn.dataset.reactKey = encodeURIComponent(payload.reactionKey);
            btn.dataset.unicode = encodeURIComponent(payload.unicode || '');
            btn.dataset.customUid = payload.customUid || '';
            btn.dataset.mine = '1';
            btn.innerHTML = `${emojiHtml || escapeHtml(payload.unicode || '🙂')} <span class="gchat-react-count">1</span>`;
            const toggle = wrap.querySelector('.gchat-react-toggle');
            wrap.insertBefore(btn, toggle || null);
        }

        async function reactGchatMessage(messageName, payload) {
            const reactPayload = typeof payload === 'string'
                ? { unicode: payload, customUid: '', reactionKey: payload }
                : payload;
            if (!messageName || !reactPayload?.reactionKey) return;
            const bubbles = [...document.querySelectorAll('.gchat-bubble')].filter(b => b.dataset.msgName === messageName);
            const wrap0 = bubbles[0]?.querySelector('.gchat-reactions');
            const chip = wrap0 ? findGchatReactionChip(wrap0, reactPayload) : null;
            const wasMine = chip?.dataset?.mine === '1';
            const optimistic = wasMine ? 'remove' : 'add';
            const emojiHtml = chip?.querySelector('img')
                ? chip.querySelector('img').outerHTML
                : escapeHtml(reactPayload.unicode || '');

            bubbles.forEach(bubble => {
                const wrap = bubble.querySelector('.gchat-reactions');
                if (wrap) applyGchatReactionDom(wrap, reactPayload, optimistic, emojiHtml);
            });

            const res = await window.api.gchatReact?.({
                messageName,
                unicode: reactPayload.unicode || '',
                customUid: reactPayload.customUid || '',
                toggle: true
            });
            if (!res?.success) {
                bubbles.forEach(bubble => {
                    const wrap = bubble.querySelector('.gchat-reactions');
                    if (wrap) applyGchatReactionDom(wrap, reactPayload, wasMine ? 'add' : 'remove', emojiHtml);
                });
                alert(res?.error || '表情回覆失敗');
                return;
            }
            const final = res.action === 'removed' ? 'remove' : 'add';
            if (final !== optimistic) {
                bubbles.forEach(bubble => {
                    const wrap = bubble.querySelector('.gchat-reactions');
                    if (wrap) applyGchatReactionDom(wrap, reactPayload, final, emojiHtml);
                });
            }
        }

        document.addEventListener('click', (e) => {
            const btn = e.target.closest?.('.gchat-react-chip, .gchat-react-add');
            if (!btn) return;
            const wrap = btn.closest('.gchat-reactions');
            if (!wrap) return;
            e.preventDefault();
            e.stopPropagation();
            const msg = btn.dataset.msgName || wrap.dataset.msgName || '';
            const reactPayload = readGchatReactPayload(btn);
            if (msg && reactPayload.reactionKey) reactGchatMessage(msg, reactPayload);
            if (btn.classList.contains('gchat-react-add')) collapseGchatReactPicker(btn);
        }, true);

        function fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const result = String(reader.result || '');
                    const comma = result.indexOf(',');
                    resolve(comma >= 0 ? result.slice(comma + 1) : result);
                };
                reader.onerror = () => reject(reader.error || new Error('讀取檔案失敗'));
                reader.readAsDataURL(file);
            });
        }

        function renderGchatAttachPreview() {
            const box = document.getElementById('gchat-attach-preview');
            if (!box) return;
            if (!gchatPendingAttachments.length) {
                box.innerHTML = '';
                return;
            }
            box.innerHTML = gchatPendingAttachments.map((f, i) => {
                const thumb = f.previewUrl
                    ? `<img src="${escapeHtml(f.previewUrl)}" alt="">`
                    : `<span>📎</span>`;
                return `<div class="gchat-attach-chip">${thumb}<span title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span><button type="button" title="移除" onclick="removeGchatAttachment(${i})">✕</button></div>`;
            }).join('');
        }

        function removeGchatAttachment(index) {
            const removed = gchatPendingAttachments.splice(index, 1)[0];
            if (removed?.previewUrl) {
                try { URL.revokeObjectURL(removed.previewUrl); } catch (_) {}
            }
            renderGchatAttachPreview();
        }

        async function addGchatAttachment(file) {
            if (!file) return;
            if (gchatPendingAttachments.length >= 5) {
                alert('一次最多附加 5 個檔案');
                return;
            }
            if (file.size > 25 * 1024 * 1024) {
                alert(`檔案太大：${file.name}`);
                return;
            }
            const dataBase64 = await fileToBase64(file);
            const isImage = /^image\//i.test(file.type || '') || /\.(gif|png|jpe?g|webp|bmp)$/i.test(file.name || '');
            gchatPendingAttachments.push({
                name: file.name || `file-${Date.now()}`,
                mimeType: file.type || 'application/octet-stream',
                dataBase64,
                previewUrl: isImage ? URL.createObjectURL(file) : ''
            });
            renderGchatAttachPreview();
        }

        function bindGchatComposer(box, editor) {
            if (!box || !editor || box.dataset.dropBound === '1') return;
            box.dataset.dropBound = '1';
            const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
            ['dragenter', 'dragover'].forEach((ev) => {
                box.addEventListener(ev, (e) => {
                    stop(e);
                    box.classList.add('is-drop');
                });
            });
            box.addEventListener('dragleave', (e) => {
                if (!box.contains(e.relatedTarget)) box.classList.remove('is-drop');
            });
            box.addEventListener('drop', async (e) => {
                stop(e);
                box.classList.remove('is-drop');
                const files = [...(e.dataTransfer?.files || [])];
                for (const f of files) await addGchatAttachment(f);
            });
            editor.addEventListener('paste', async (e) => {
                const items = [...(e.clipboardData?.items || [])];
                let handled = false;
                for (const it of items) {
                    if (it.kind !== 'file') continue;
                    const f = it.getAsFile();
                    if (!f) continue;
                    handled = true;
                    await addGchatAttachment(f);
                }
                if (handled) e.preventDefault();
            });
        }

        function gchatBubbleSenderLabel(m, mine) {
            if (mine) return '我';
            return m?.sender || '成員';
        }

        function renderGchatBubbleHtml(m, { pending, failed, tempId } = {}) {
            const nameAttr = escapeHtml(m.name || tempId || '');
            const threadAttr = escapeHtml(m.threadName || m.name || '');
            const senderAttr = escapeHtml(m.sender || '');
            const createAttr = escapeHtml(m.createTime || '');
            const updateAttr = escapeHtml(m.lastUpdateTime || m.createTime || '');
            const mine = pending || isGchatMineMessage(m);
            const cls = ['gchat-bubble'];
            if (mine) cls.push('is-mine');
            if (pending) cls.push('is-pending');
            if (failed) cls.push('is-failed');
            const canReply = !pending && !!m.name && !mine;
            const replyUnder = canReply
                ? `<button type="button" class="gchat-reply-under" title="引用回覆此訊息">${gchatReplyIconHtml()}<span>回覆</span></button>`
                : '';
            // Google Chat API 不提供「對方已讀」回條；己方訊息改顯示已送出時間
            let receipt = '';
            if (mine) {
                if (failed) receipt = `<div class="gchat-receipt">送出失敗</div>`;
                else if (pending) receipt = `<div class="gchat-receipt">傳送中…</div>`;
                else receipt = `<div class="gchat-receipt" title="Google Chat API 不支援對方已讀狀態">已送出${m.createTimeLabel ? ` · ${escapeHtml(m.createTimeLabel)}` : ''}</div>`;
            }
            const quoteHtml = renderGchatQuoteHtml(m.quoted);
            const reactHtml = pending ? '' : renderGchatReactionsHtml(m);
            return `
                <div class="${cls.join(' ')}" data-msg-name="${nameAttr}" data-thread-name="${threadAttr}" data-sender="${senderAttr}" data-create-time="${createAttr}" data-last-update-time="${updateAttr}" data-mine="${mine ? '1' : '0'}" ${tempId ? `data-temp-id="${escapeHtml(tempId)}"` : ''}>
                    <div class="gchat-bubble-top">
                        <div class="gchat-meta">${escapeHtml(gchatBubbleSenderLabel(m, mine))} · ${escapeHtml(m.createTimeLabel || '')}</div>
                    </div>
                    ${quoteHtml}
                    <div class="gchat-text">${renderGchatMessageBodyHtml(m)}</div>
                    ${renderGchatMedia(m.media, { hideCardDecor: !!(m.cardHtml || m.cardLinks?.length) })}
                    ${reactHtml}
                    ${receipt}
                    ${replyUnder}
                </div>`;
        }

        function bindGchatBubbleReplyButtons(root) {
            const scope = root || document;
            scope.querySelectorAll('.gchat-reply-under').forEach(btn => {
                if (btn.dataset.boundReply === '1') return;
                btn.dataset.boundReply = '1';
                btn.addEventListener('click', (event) => {
                    const bubble = btn.closest('.gchat-bubble');
                    startGchatReplyToMessage(bubble && bubble.dataset ? bubble.dataset.msgName : '', event);
                });
            });
            markGchatReplyIconsMaterial();
        }

        function appendGchatThreadMessages(thread) {
            const scroll = document.getElementById('gchat-thread-scroll');
            if (!scroll || !Array.isArray(thread)) return false;
            const existing = new Set(
                [...scroll.querySelectorAll('[data-msg-name]')]
                    .map(el => el.dataset.msgName)
                    .filter(Boolean)
            );
            let added = false;
            for (const m of thread) {
                if (!m?.name || existing.has(m.name)) continue;
                // 若樂觀泡泡已在，用正式訊息替換
                const pendingMine = [...scroll.querySelectorAll('.gchat-bubble.is-pending[data-temp-id]')];
                const textKey = String(m.text || '').trim();
                const matchPending = pendingMine.find(el => {
                    const t = (el.querySelector('.gchat-text')?.innerText || '').trim();
                    if (textKey && t && t === textKey) return true;
                    if (!textKey && m.media?.length && !t) return true;
                    return false;
                });
                if (matchPending) {
                    matchPending.outerHTML = renderGchatBubbleHtml(m);
                    existing.add(m.name);
                    added = true;
                    continue;
                }
                scroll.insertAdjacentHTML('beforeend', renderGchatBubbleHtml(m));
                existing.add(m.name);
                added = true;
            }
            if (added) {
                if (isGchatThreadNearBottom(scroll)) {
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        scroll.scrollTop = scroll.scrollHeight;
                    }));
                }
                bindGchatBubbleReplyButtons(scroll);
            }
            return added;
        }

        async function refreshOpenGchatThread() {
            const modal = document.getElementById('detail-modal');
            if (!modal || modal.style.display === 'none' || !currentGchatContext?.spaceName) return;
            if (gchatThreadRefreshBusy) return;
            if (gchatApiQuotaBlockedUntil && Date.now() < gchatApiQuotaBlockedUntil) return;
            gchatThreadRefreshBusy = true;
            const payload = {
                spaceName: currentGchatContext.spaceName,
                threadName: currentGchatContext.threadName || '',
                name: currentGchatContext.name || '',
                isDm: !!currentGchatContext.isDm,
                spaceType: currentGchatContext.spaceType || ''
            };
            try {
                const cachedRes = await window.api.gchatThreadRefresh?.({ ...payload, cacheOnly: true });
                if (cachedRes?.success && cachedRes.thread) {
                    applyGchatIdentityFromRes(cachedRes);
                    appendGchatThreadMessages(cachedRes.thread);
                }
                const res = await window.api.gchatThreadRefresh?.(payload);
                if (res?.quotaBlocked) {
                    gchatApiQuotaBlockedUntil = Number(res.quotaBlockedUntil) || (Date.now() + 30 * 60 * 1000);
                }
                if (res?.success && res.thread) {
                    applyGchatIdentityFromRes(res);
                    appendGchatThreadMessages(res.thread);
                    const newest = [...res.thread].reverse().find(m => m?.name);
                    if (newest?.name) {
                        window.api.gchatMarkRead({
                            name: newest.name,
                            createTime: newest.createTime || '',
                            threadName: newest.threadName || currentGchatContext.threadName || '',
                            spaceName: newest.spaceName || currentGchatContext.spaceName || ''
                        }).catch?.(() => {});
                    }
                }
            } catch (_) {
            } finally {
                gchatThreadRefreshBusy = false;
            }
        }

        function scrollGchatToFocusMessage(messageName) {
            const scroller = document.getElementById('gchat-thread-scroll');
            if (!scroller) return;
            const scrollToCenter = (el) => {
                const scrollerRect = scroller.getBoundingClientRect();
                const elRect = el.getBoundingClientRect();
                const elTopInScroll = scroller.scrollTop + (elRect.top - scrollerRect.top);
                const target = elTopInScroll - (scroller.clientHeight - elRect.height) / 2;
                const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                scroller.scrollTop = Math.max(0, Math.min(target, maxScroll));
            };
            const run = () => {
                scroller.querySelectorAll('.gchat-bubble.is-focus').forEach(el => el.classList.remove('is-focus'));
                let el = null;
                if (messageName) {
                    el = [...scroller.querySelectorAll('[data-msg-name]')].find(n => n.dataset.msgName === messageName) || null;
                }
                if (!el) {
                    scroller.scrollTop = scroller.scrollHeight;
                    return;
                }
                el.classList.add('is-focus');
                scrollToCenter(el);
            };
            requestAnimationFrame(() => requestAnimationFrame(run));
            setTimeout(run, 80);
            setTimeout(run, 250);
        }

        function renderGchatModalBody(detail, thread, { fromCache, historyLoading } = {}) {
            gchatPendingAttachments = [];
            gchatReplyTarget = null;
            const list = Array.isArray(thread) && thread.length ? thread : [];
            const threadHtml = historyLoading
                ? `<div class="loading" style="padding:16px;">載入歷史訊息…</div>`
                : (list.length
                    ? list.map(m => renderGchatBubbleHtml(m)).join('')
                    : `<div class="loading" style="padding:16px;opacity:.75;">尚無訊息，打個招呼吧</div>`);
            const metaText = historyLoading
                ? '歷史載入中…可先輸入訊息'
                : `來自 ${escapeHtml((() => {
                    const peer = gchatConversationTitle(detail);
                    const sender = String(detail.sender || '').trim();
                    if (sender && sender !== '我' && !gchatIsSelfTitlePart(sender)) return sender;
                    return peer;
                })())}${fromCache ? '' : ' · 剛更新歷史'}`;
            document.getElementById('modal-body').innerHTML = `
                <div class="mail-view">
                    <div class="modal-title">💬 ${escapeHtml(gchatConversationTitle(detail))}</div>
                    <div class="mail-meta">${metaText}</div>
                    <div class="gchat-thread" id="gchat-thread-scroll">${threadHtml}</div>
                    <div class="gchat-reply-box" id="gchat-reply-box">
                        <div id="gchat-reply-target-chip" class="gchat-reply-target-chip">
                            <div class="chip-body">
                                <div class="chip-label">回覆此訊息</div>
                                <div class="chip-preview"></div>
                            </div>
                            <button type="button" title="取消回覆對象" onclick="clearGchatReplyTarget()">✕</button>
                        </div>
                        <div class="gchat-editor-toolbar">
                            <button type="button" id="gchat-btn-bold" title="粗體" aria-pressed="false" onclick="gchatEditorCmd('bold')"><b>B</b></button>
                            <button type="button" id="gchat-btn-italic" title="斜體" aria-pressed="false" onclick="gchatEditorCmd('italic')"><i>I</i></button>
                            <label class="gchat-color-btn" title="顏色（本機預覽）">🎨
                                <input type="color" value="#c45c26" onchange="gchatEditorColor(this.value)">
                            </label>
                            <button type="button" id="gchat-composer-emoji-anchor" title="表情" onclick="toggleGchatEmojiPicker()">😊</button>
                            <label class="gchat-color-btn" title="附加檔案">📎
                                <input type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip" onchange="onGchatAttachPick(event)" style="position:absolute;width:0;height:0;opacity:0;">
                            </label>
                        </div>
                        <div id="gchat-emoji-picker" class="gchat-emoji-picker">${buildGchatEmojiPicker()}</div>
                        <div id="gchat-reply-text" class="gchat-editor" contenteditable="true" data-placeholder="輸入回覆…（可拖曳圖片／檔案進來）"></div>
                        <div id="gchat-attach-preview" class="gchat-attach-preview"></div>
                        <label class="gchat-thread-opt">
                            <input type="checkbox" id="gchat-reply-in-thread" onchange="if(!this.checked) clearGchatReplyTarget()">
                            <span>此對話串回覆</span>
                        </label>
                        <div class="gchat-editor-footer">
                            <div class="gchat-editor-hint">Enter 立即送出 · Shift+Enter 換行 · 可拖曳／貼上圖片 · 點泡泡下方 ↪ 可回覆該則</div>
                            <div class="gchat-actions">
                                <button type="button" class="btn-ghost" onclick="openCurrentGchatExternal()">在 Chat 開啟</button>
                            </div>
                        </div>
                    </div>
                </div>`;
            if (!historyLoading) scrollGchatToFocusMessage(detail?.name);
            const editor = document.getElementById('gchat-reply-text');
            const box = document.getElementById('gchat-reply-box');
            bindGchatComposer(box, editor);
            bindGchatBubbleReplyButtons(document.getElementById('gchat-thread-scroll'));
            bindGchatEditorToolbarState(editor);
            syncGchatEditorToolbarState();
            if (editor) {
                editor.focus();
                editor.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                        event.preventDefault();
                        sendGchatReply();
                    }
                });
            }
        }

        async function onGchatAttachPick(event) {
            const files = [...(event.target?.files || [])];
            event.target.value = '';
            for (const f of files) await addGchatAttachment(f);
        }

        let gchatUiPacketCache = new Map(); // messageName / trackKey → { detail, thread, at }

        function gchatUiCacheKey(detailOrName) {
            if (!detailOrName) return '';
            if (typeof detailOrName === 'string') return detailOrName;
            if (detailOrName.spaceName) {
                const isDm = detailOrName.isDm || detailOrName.spaceType === 'DIRECT_MESSAGE';
                return `${isDm ? 'dm' : 'sp'}:${detailOrName.spaceName}`;
            }
            return detailOrName.name || '';
        }

        function rememberGchatUiPacket(detail, thread) {
            if (!detail) return;
            const payload = { detail, thread: thread || [detail], at: Date.now() };
            if (detail.name) gchatUiPacketCache.set(detail.name, payload);
            const track = gchatUiCacheKey(detail);
            if (track) gchatUiPacketCache.set(track, payload);
            // 上限避免記憶體膨脹
            if (gchatUiPacketCache.size > 60) {
                const oldest = [...gchatUiPacketCache.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0)).slice(0, 20);
                oldest.forEach(([k]) => gchatUiPacketCache.delete(k));
            }
        }

        function gchatUiPacketMediaBroken(packet) {
            const thread = packet?.thread || [];
            for (const m of thread) {
                for (const x of (m?.media || [])) {
                    if (!x) continue;
                    const imageLike = x.kind === 'image' || x.kind === 'gif' || x.kind === 'pdf'
                        || /\.(png|jpe?g|gif|webp|bmp|pdf)$/i.test(String(x.name || ''));
                    if (!imageLike) continue;
                    if (!(x.dataUrl || x.previewUrl || x.uri)) return true;
                }
            }
            return false;
        }

        function findGchatUiPacket(name, spaceName = '', isDm = '') {
            if (name && gchatUiPacketCache.has(name)) return gchatUiPacketCache.get(name);
            if (spaceName) {
                const track = `${isDm === '1' || isDm === true ? 'dm' : 'sp'}:${spaceName}`;
                if (gchatUiPacketCache.has(track)) return gchatUiPacketCache.get(track);
            }
            return null;
        }

        async function showGchatModal(name, spaceName = '', isDm = '') {
            await openGchatFocusFromList(name, spaceName, isDm);
        }
        async function sendGchatReply() {
            if (!currentGchatContext || gchatReplySending) return;
            // 搜尋剛開啟、空間還在解析：等就緒再送，草稿不丟
            if (gchatOpenPending || !currentGchatContext.spaceName) {
                const pending = gchatOpenPending;
                if (pending) {
                    const opened = await pending;
                    if (!opened?.success) {
                        alert(opened?.error || '對話尚未就緒，請稍後再送');
                        return;
                    }
                }
                if (!currentGchatContext?.spaceName) {
                    alert('對話尚未就緒，請稍後再送');
                    return;
                }
            }
            const text = getGchatReplyText();
            const attachments = gchatPendingAttachments.map(a => ({
                name: a.name,
                mimeType: a.mimeType,
                dataBase64: a.dataBase64
            }));
            if (!text && !attachments.length) return;

            const replyInThread = !!document.getElementById('gchat-reply-in-thread')?.checked;
            const replyMessageName = (replyInThread && gchatReplyTarget?.messageName)
                ? gchatReplyTarget.messageName
                : (currentGchatContext.name || '');
            const replyThreadName = (replyInThread && (gchatReplyTarget?.threadName || gchatReplyTarget?.messageName))
                ? (gchatReplyTarget.threadName || gchatReplyTarget.messageName)
                : (currentGchatContext.threadName || '');
            const editor = document.getElementById('gchat-reply-text');
            const scroll = document.getElementById('gchat-thread-scroll');
            const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const nowLabel = new Date().toLocaleString('zh-TW', {
                month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const localMedia = gchatPendingAttachments.map(a => ({
                kind: /^image\//i.test(a.mimeType) ? 'image' : 'file',
                name: a.name,
                previewUrl: a.previewUrl || '',
                dataUrl: a.previewUrl || ''
            }));

            // 樂觀更新：先上畫面，再打 API
            if (scroll) {
                scroll.insertAdjacentHTML('beforeend', renderGchatBubbleHtml({
                    name: '',
                    sender: '我',
                    createTimeLabel: nowLabel,
                    text,
                    media: localMedia
                }, { pending: true, tempId }));
                scroll.scrollTop = scroll.scrollHeight;
            }
            if (editor) {
                editor.innerHTML = '';
                editor.focus();
            }
            const keptPreviews = gchatPendingAttachments.map(a => a.previewUrl).filter(Boolean);
            gchatPendingAttachments = [];
            renderGchatAttachPreview();

            gchatReplySending = true;
            const quoteMessageName = (replyInThread && gchatReplyTarget?.messageName)
                ? gchatReplyTarget.messageName
                : '';
            const quoteLastUpdateTime = (replyInThread && gchatReplyTarget)
                ? (gchatReplyTarget.lastUpdateTime || gchatReplyTarget.createTime || '')
                : '';
            const res = await window.api.gchatReply({
                text,
                spaceName: currentGchatContext.spaceName,
                threadName: replyThreadName,
                messageName: replyMessageName,
                createTime: currentGchatContext.createTime,
                isDm: !!currentGchatContext.isDm,
                spaceType: currentGchatContext.spaceType || '',
                spaceDisplayName: currentGchatContext.spaceDisplayName || '',
                sender: currentGchatContext.sender || '',
                replyInThread,
                quoteMessageName,
                quoteLastUpdateTime,
                attachments
            });
            gchatReplySending = false;

            const pendingEl = document.querySelector(`[data-temp-id="${tempId}"]`);
            if (res?.success) {
                clearGchatReplyTarget();
                if (pendingEl && res.created) {
                    pendingEl.outerHTML = renderGchatBubbleHtml(res.created);
                } else if (pendingEl) {
                    pendingEl.classList.remove('is-pending');
                    if (res.created?.name) pendingEl.dataset.msgName = res.created.name;
                }
                keptPreviews.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
                const list = document.getElementById('gchat-list');
                if (list) {
                    updateGchatHint(res);
                    paintGchatList(res.messages || []);
                }
                // 背景再拉一次，確保對方側／附件完整
                refreshOpenGchatThread();
            } else {
                if (pendingEl) pendingEl.classList.add('is-failed');
                const msg = res?.error || '回覆失敗';
                if (res?.needsChatApp) {
                    alert(`${msg}\n\n若持續失敗，請到齒輪重新「授權 Google Chat」。`);
                } else if (res?.needsApi) {
                    const go = confirm(`${msg}\n\n要開啟 Chat API 啟用頁嗎？`);
                    if (go) await openGchatApiSetup();
                } else if (res?.needsReauth || res?.featureScopeMissing || res?.needsAuth || res?.authRevoked) {
                    const go = confirm(`${msg}\n\n要補充 Google Chat 授權嗎？`);
                    if (go) await authorizeGchat();
                } else {
                    alert(msg);
                }
            }
        }

        function openCurrentGchatExternal() {
            const url = currentGchatContext?.openUrl || 'https://chat.google.com/';
            window.api.openExternal(url);
        }

        async function openGchatApiSetup() {
            const res = await window.api.gchatOpenSetup();
            const hint = document.getElementById('gchat-settings-hint');
            if (hint) hint.textContent = '已打開 Google Cloud。請按「啟用／ENABLE」，約一分鐘後再按「授權 Google Chat」。';
            return res;
        }

        async function openGchatAppConfig() {
            const res = await window.api.gchatOpenAppConfig?.();
            const hint = document.getElementById('gchat-app-config-hint') || document.getElementById('gchat-settings-hint');
            if (hint) {
                hint.textContent = '已打開設定頁。只要填名稱／頭像／說明，並關閉「互動功能」（不要填 HTTP 端點）。儲存後回 App 重試送出。';
            }
            return res;
        }

        async function openGchatAdminSetup() {
            const res = await window.api.gchatOpenAdminSetup();
            const hint = document.getElementById('gchat-settings-hint');
            if (hint) hint.textContent = '已打開 Admin SDK API 頁。請按「啟用／ENABLE」，再開授權。這是查「資訊管理_林楷翔3015」這類姓名需要的。';
            return res;
        }

        async function authorizeGchat() {
            const hint = document.getElementById('gchat-settings-hint');
            if (hint) hint.textContent = '正在打開 Google 授權頁，請允許 Chat 與目錄使用者（才能顯示姓名）…';
            const ok = await authorizeFeature('gchat');
            if (!ok) {
                const res = await window.api.featureAuthStatus?.('gchat');
                if (hint) hint.textContent = res?.error || '授權失敗';
                return false;
            }
            if (hint) hint.textContent = 'Little Reply 授權完成，可加入「Little Reply」小工具。';
            if (document.getElementById('gchat-list')) loadGchat();
            return true;
        }



        // ✨ ----- 新增日曆行程的相關函式 (開始) -----

        // ========== 【FEATURE: calendar】建立行程表單 ==========
        function showCreateEventModal() {
            setModalKind('');
            document.getElementById('modal-body').innerHTML = `
                <div class="modal-title">📝 新增日曆行程</div>
                <form id="create-event-form" style="display: flex; flex-direction: column; gap: 15px; padding-top: 15px;">
                    <style>
                        #create-event-form label { font-weight: 600; font-size: 0.9em; color: var(--text-sub); }
                        #create-event-form input, #create-event-form textarea, #create-event-form select {
                            width: 100%; padding: 12px; border: 1px solid var(--item-border); box-sizing: border-box;
                            border-radius: 8px; background: var(--bg-color); color: var(--text-main); font-size: 1em;
                        }
                    </style>
                    <div>
                        <label for="event-calendar">儲存至日曆:</label>
                        <select id="event-calendar" required></select>
                    </div>
                    <div>
                        <label for="event-summary">行程標題:</label>
                        <input type="text" id="event-summary" required>
                    </div>
                    <div>
                        <label for="event-location">地點 (可選):</label>
                        <input type="text" id="event-location">
                    </div>
                    <div style="display: flex; gap: 15px;">
                        <div style="flex: 1;">
                            <label for="event-start">開始時間:</label>
                            <input type="datetime-local" id="event-start" required>
                        </div>
                        <div style="flex: 1;">
                            <label for="event-end">結束時間:</label>
                            <input type="datetime-local" id="event-end" required>
                        </div>
                    </div>
                    <div>
                        <label for="event-description">描述 (可選):</label>
                        <textarea id="event-description" rows="4"></textarea>
                    </div>
                    <div style="text-align: right; margin-top: 10px;">
                        <button type="button" class="btn-primary" id="submit-event-btn" onclick="submitCalendarEvent()">儲存行程</button>
                    </div>
                </form>
            `;
            document.getElementById('detail-modal').style.display = 'flex';
            const select = document.getElementById('event-calendar');
            const options = (writableCalendars.length ? writableCalendars : [{ id: 'primary', name: '主要日曆', primary: true }])
                .map(c => `<option value="${escapeHtml(c.id)}" ${c.primary ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
                .join('');
            select.innerHTML = options;
        }

        async function submitCalendarEvent() {
            const form = document.getElementById('create-event-form');
            if (!form.checkValidity()) {
                alert('請填寫所有必填欄位 (標題、開始/結束時間)');
                return;
            }

            const submitBtn = document.getElementById('submit-event-btn');
            submitBtn.textContent = '儲存中...';
            submitBtn.disabled = true;

            const eventDetails = {
                calendarId: document.getElementById('event-calendar').value,
                summary: document.getElementById('event-summary').value,
                location: document.getElementById('event-location').value,
                description: document.getElementById('event-description').value,
                startDateTime: new Date(document.getElementById('event-start').value).toISOString(),
                endDateTime: new Date(document.getElementById('event-end').value).toISOString()
            };

            try {
                const result = await window.api.createCalendarEvent(eventDetails);
                if (result.success) {
                    alert('行程新增成功！');
                    closeModal();
                    loadCalendar(); // ✅ 成功後自動刷新日曆列表
                } else {
                    alert('新增失敗：' + result.error);
                }
            } catch (error) {
                alert('發生錯誤：' + error.message);
            } finally {
                submitBtn.textContent = '儲存行程';
                submitBtn.disabled = false;
            }
        }
        // ✨ ----- 新增日曆行程的相關函式 (結束) -----

        // 💡 主題與初始設定
        const THEMES = {
            light: { name: '紙感', icon: '🤍', dot: '#2f4a66' },
            dark: { name: '深夜', icon: '🌙', dot: '#9eb4cf' },
            forest: { name: '森綠', icon: '🌿', dot: '#246338' },
            ocean: { name: '海霧', icon: '🌊', dot: '#1f5a7a' },
            clay: { name: '暖陶', icon: '🧡', dot: '#9a3f1e' },
            ink: { name: '墨藍', icon: '🌌', dot: '#8eb6e0' },
            matcha: { name: '抹茶', icon: '🍵', dot: '#4f6328' }
        };

        const FONT_SCALE_KEY = 'ui-font-scale-v1';
        const FONT_SCALE_OPTIONS = [0.75, 1, 1.25, 1.5];

        function getUiScale() {
            const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale'));
            return Number.isFinite(raw) && raw > 0 ? raw : 1;
        }

        function syncFontScaleButtons(scale) {
            document.querySelectorAll('.font-scale-btn').forEach(btn => {
                const v = Number(btn.dataset.scale);
                btn.classList.toggle('active', Math.abs(v - scale) < 0.001);
            });
        }

        function applyFontScale(scale, { persist = true } = {}) {
            let next = Number(scale);
            if (!FONT_SCALE_OPTIONS.some(v => Math.abs(v - next) < 0.001)) next = 1;
            document.documentElement.style.setProperty('--ui-scale', String(next));
            if (persist) {
                localStorage.setItem(FONT_SCALE_KEY, String(next));
                window.api.setAppFontScale?.(next).catch?.(() => {});
            }
            syncFontScaleButtons(next);
            // 拼貼區塊列高／間距跟著縮放，避免放大後破版
            requestAnimationFrame(() => {
                try { applyTileGeometry(); } catch (_) {}
            });
        }

        function applyTheme(id) {
            const theme = THEMES[id] ? id : 'light';
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem('theme', theme);
            document.getElementById('theme-btn').textContent = THEMES[theme].icon;
            document.getElementById('theme-menu')?.classList.remove('open');
            renderThemeMenu();
            // [Important] 同步泡泡框／最小化 bar 風格
            window.api.setAppTheme?.(theme).catch?.(() => {});
        }

        function renderThemeMenu() {
            const menu = document.getElementById('theme-menu');
            if (!menu) return;
            const current = document.documentElement.getAttribute('data-theme') || 'light';
            menu.innerHTML = Object.entries(THEMES).map(([id, t]) => `
                <button class="theme-option ${current === id ? 'active' : ''}" onclick="applyTheme('${id}')">
                    <span class="theme-dot" style="background:${t.dot}"></span>
                    ${t.name}
                </button>
            `).join('');
        }


        // ========== 【MODULE: settings】主題／字級／更新／Tray ==========
        function toggleThemeMenu() {
            const menu = document.getElementById('theme-menu');
            document.getElementById('app-settings-menu')?.classList.remove('open');
            renderThemeMenu();
            menu.classList.toggle('open');
        }

        async function toggleAppSettings() {
            const menu = document.getElementById('app-settings-menu');
            document.getElementById('theme-menu')?.classList.remove('open');
            const opening = !menu.classList.contains('open');
            menu.classList.toggle('open', opening);
            if (opening) await loadAppSettings();
        }

        async function applySettingsMode() {
            // [Important] 預設隱藏開發者設定；確認為 npm start 才顯示
            let isDev = false;
            try {
                const mode = await window.api.getAppMode?.();
                if (mode && mode.success !== false) {
                    isDev = !!mode.dev && !mode.packaged;
                }
            } catch (_) {}
            appIsDev = isDev;
            const panels = document.getElementById('dev-settings-panels');
            if (panels) panels.hidden = !isDev;
            return isDev;
        }

        async function loadAppSettings() {
            const isDev = await applySettingsMode();
            syncFontScaleButtons(getUiScale());
            await refreshAppVersionInfo();
            const openAtLogin = document.getElementById('open-at-login');
            if (openAtLogin && window.api.getOpenAtLogin) {
                const loginRes = await window.api.getOpenAtLogin();
                openAtLogin.checked = !!loginRes.openAtLogin;
            }
            const alertBox = document.getElementById('gchat-alert-popup');
            const trayBox = document.getElementById('close-to-tray');
            if (window.api.gchatGetPrefs) {
                const prefs = await window.api.gchatGetPrefs();
                if (alertBox) {
                    alertBox.checked = prefs?.alertPopup !== false;
                    gchatAlertEnabled = prefs?.alertPopup !== false;
                }
                if (trayBox) trayBox.checked = prefs?.closeToTray !== false;
            }
            if (isDev) {
                await renderSheetSources();
                await renderSitesVisitsSettings();
            }
        }

        let appUpdateUiState = { available: false, downloaded: false, version: '', percent: 0 };

        function paintAppUpdateStatus(st) {
            if (!st) return;
            appUpdateUiState = { ...appUpdateUiState, ...st };
            const verEl = document.getElementById('app-version-label');
            const hint = document.getElementById('app-update-hint');
            const btn = document.getElementById('app-update-action-btn');
            const cur = st.currentVersion || st.versionLocal || '';
            if (verEl && cur) verEl.textContent = `目前版本：${cur}`;
            if (!hint || !btn) return;
            btn.style.display = 'none';
            if (st.checking) {
                hint.textContent = '正在檢查更新…';
                return;
            }
            if (st.downloading) {
                hint.textContent = `正在下載更新… ${Number(st.percent || 0)}%`;
                return;
            }
            if (st.downloaded) {
                hint.textContent = `新版本 ${st.version || ''} 已下載。請按「確認安裝並重開」（不會自動安裝）。`;
                btn.style.display = '';
                btn.textContent = '確認安裝並重開';
                return;
            }
            if (st.available) {
                hint.textContent = `有新版本 ${st.version || ''}。請按「確認更新」才會下載（不會自動更新）。`;
                btn.style.display = '';
                btn.textContent = '確認更新';
                return;
            }
            if (st.error && /開發模式/.test(String(st.error))) {
                hint.textContent = st.error;
                return;
            }
            if (st.error) {
                hint.textContent = `更新檢查：${st.error}`;
                return;
            }
            hint.textContent = '已是最新版本。有新版時會跳出訊息，需您確認後才更新。';
        }

        async function refreshAppVersionInfo() {
            try {
                const ver = await window.api.appGetVersion?.();
                if (ver?.version) {
                    const el = document.getElementById('app-version-label');
                    if (el) el.textContent = `目前版本：${ver.version}`;
                }
                const st = await window.api.appGetUpdateStatus?.();
                if (st) paintAppUpdateStatus(st);
            } catch (_) {}
        }

        async function checkAppUpdateManual() {
            const hint = document.getElementById('app-update-hint');
            if (hint) hint.textContent = '正在檢查更新…';
            const res = await window.api.appCheckUpdate?.({ silent: false });
            paintAppUpdateStatus(res || {});
        }

        async function runAppUpdateAction() {
            if (appUpdateUiState.downloaded) {
                const res = await window.api.appInstallUpdate?.();
                if (!res?.success) alert(res?.error || '無法安裝更新');
                return;
            }
            if (appUpdateUiState.available) {
                const hint = document.getElementById('app-update-hint');
                if (hint) hint.textContent = '開始下載更新…';
                const res = await window.api.appDownloadUpdate?.();
                if (!res?.success) {
                    alert(res?.error || '無法下載更新');
                    paintAppUpdateStatus(res || {});
                }
            }
        }

        window.api.onAppUpdateStatus?.((st) => paintAppUpdateStatus(st));

        async function renderSitesVisitsSettings() {
            const box = document.getElementById('sites-project-list');
            const hint = document.getElementById('sites-visits-hint');
            const deployInput = document.getElementById('sites-deploy-url');
            const linksBox = document.getElementById('sites-track-links');
            if (!box || !window.api.sitesVisitsGetConfig) return;
            const res = await window.api.sitesVisitsGetConfig();
            if (!res?.success) {
                if (hint) hint.textContent = res?.error || '無法讀取設定';
                return;
            }
            if (deployInput) deployInput.value = res.deployWebAppUrl || '';
            const sheetHint = document.getElementById('sites-log-sheet-id');
            if (sheetHint) {
                sheetHint.innerHTML = res.logSpreadsheetId
                    ? `紀錄試算表 ID：<code>${escapeHtml(res.logSpreadsheetId)}</code>（Apps Script 的 LOG_SHEET_ID 必須是這個）`
                    : '尚無紀錄試算表。請先加入專案（會自動建立）。';
            }
            const projects = res.projects || [];
            box.innerHTML = projects.map(p => `
                <div class="sheet-source-row">
                    <span title="${escapeHtml(p.siteId || p.siteSlug || p.siteUrl || '')}">${escapeHtml(p.name)}${p.siteId ? ` · ${escapeHtml(p.siteId)}` : (p.siteSlug ? ` · slug:${escapeHtml(p.siteSlug)}` : '')}</span>
                    <button type="button" onclick="removeSitesVisitProject('${p.id}')">移除</button>
                </div>
            `).join('');
            renderSitesTrackLinks(res.trackLinks);
            if (hint) {
                if (!projects.length) {
                    hint.textContent = '請先輸入 /d/ Site ID 並加入專案。';
                } else if (!res.deployWebAppUrl) {
                    hint.textContent = '專案已設定。請部署網頁應用程式後，把 /exec 網址貼上方並儲存。';
                } else {
                    hint.textContent = `已設定 ${projects.length} 個 Site，部署網址已存。本機累積 ${res.localCount || 0} 筆。`;
                }
            }
        }

        function renderSitesTrackLinks(links) {
            const linksBox = document.getElementById('sites-track-links');
            if (!linksBox) return;
            if (!links?.embed) {
                linksBox.innerHTML = '<p class="settings-hint">儲存正確的 /exec 部署網址後，這裡會出現可複製的嵌入／點擊／轉址連結。</p>';
                return;
            }
            const rows = [
                ['嵌入（造訪）', links.embed],
                ['點擊測試', links.click],
                ['轉址範例（先記數再導向 Google）', links.link]
            ];
            linksBox.innerHTML = rows.map(([title, url], i) => `
                <div class="sheet-source-row" style="align-items:flex-start;">
                    <span style="flex:1;word-break:break-all;"><strong>${title}</strong><br><code style="font-size:11px;">${escapeHtml(url)}</code></span>
                    <button type="button" onclick="copySitesTrackLink(${i})">複製</button>
                </div>
            `).join('');
            window.__sitesTrackLinkList = rows.map(r => r[1]);
        }

        async function copySitesTrackLink(idx) {
            const url = (window.__sitesTrackLinkList || [])[idx];
            const hint = document.getElementById('sites-visits-hint');
            if (!url) return;
            try {
                await navigator.clipboard.writeText(url);
                if (hint) hint.textContent = '已複製連結。嵌入請用「嵌入」；按鈕請用「點擊／轉址」。';
            } catch (_) {
                if (hint) hint.textContent = url;
            }
        }

        async function saveSitesDeployUrl() {
            const hint = document.getElementById('sites-visits-hint');
            const raw = document.getElementById('sites-deploy-url')?.value || '';
            const res = await window.api.sitesVisitsSaveConfig({ deployWebAppUrl: raw });
            if (!res?.success) {
                if (hint) hint.textContent = res?.error || '部署網址無效';
                return;
            }
            renderSitesTrackLinks(res.trackLinks);
            if (hint) {
                hint.textContent = res.trackLinks?.embed
                    ? '部署網址已儲存。請複製「嵌入」網址嵌進 Site，並用同仁帳號測試是否顯示「追蹤就緒」。'
                    : '部署網址已儲存。若尚無專案，請先加入 Site ID。';
            }
        }

        async function addSitesVisitProject() {
            const name = document.getElementById('sites-project-name')?.value || '';
            const siteId = document.getElementById('sites-project-url')?.value || '';
            const res = await window.api.sitesVisitsAddProject({ name, siteId });
            const hint = document.getElementById('sites-visits-hint');
            if (!res?.success) {
                if (hint) hint.textContent = res?.error || '無法加入專案';
                return;
            }
            document.getElementById('sites-project-name').value = '';
            document.getElementById('sites-project-url').value = '';
            if (hint) hint.textContent = res.message || '已加入。請複製 Apps Script 並依下方步驟嵌進 Site。';
            await renderSitesVisitsSettings();
            if (document.getElementById('sites-visits-list')) loadSitesVisits();
        }

        async function removeSitesVisitProject(id) {
            const res = await window.api.sitesVisitsRemoveProject(id);
            if (!res?.success) {
                alert(res?.error || '無法移除');
                return;
            }
            await renderSitesVisitsSettings();
            if (document.getElementById('sites-visits-list')) loadSitesVisits();
        }

        async function copySitesLogSheetId() {
            const hint = document.getElementById('sites-visits-hint');
            const res = await window.api.sitesVisitsGetConfig();
            const id = res?.logSpreadsheetId || '';
            if (!id) {
                if (hint) hint.textContent = '尚無試算表 ID，請先加入專案。';
                return;
            }
            try {
                await navigator.clipboard.writeText(id);
                if (hint) hint.textContent = `已複製試算表 ID。到 Apps Script 改成：var LOG_SHEET_ID = '${id}'; 後務必「管理部署→新版本」。`;
            } catch (_) {
                if (hint) hint.textContent = id;
            }
        }

        async function openSitesLogSheet() {
            const hint = document.getElementById('sites-visits-hint');
            const res = await window.api.sitesVisitsOpenLogSheet();
            if (!res?.success) {
                if (hint) hint.textContent = res?.error || '無法開啟試算表';
                return;
            }
            if (hint) hint.textContent = '已開啟紀錄試算表。同仁造訪後應出現新列。';
        }

        async function copySitesTrackerScript() {
            const hint = document.getElementById('sites-visits-hint');
            const box = document.getElementById('sites-tracker-script-box');
            const res = await window.api.sitesVisitsTrackerScript();
            if (!res?.success) {
                if (hint) hint.textContent = res?.error || '無法產生程式';
                return;
            }
            const script = res.script || '';
            const expect = `var LOG_SHEET_ID = '${res.logSpreadsheetId}'`;
            if (!res.logSpreadsheetId || !script.includes(expect)) {
                if (hint) hint.textContent = '程式未含正確試算表 ID。請先加入專案後再複製。';
                return;
            }
            if (box) {
                box.style.display = 'block';
                box.value = script;
                box.focus();
                box.select();
            }
            let copied = false;
            try {
                await navigator.clipboard.writeText(script);
                copied = true;
            } catch (_) {}
            if (!copied) {
                try {
                    document.execCommand('copy');
                    copied = true;
                } catch (_) {}
            }
            if (hint) {
                hint.textContent = copied
                    ? `已複製完整程式（LOG_SHEET_ID=${res.logSpreadsheetId}）。到 script.google.com 全選覆蓋貼上 → 儲存 → 管理部署→新版本。下方文字框也可手動全選複製。`
                    : `剪貼簿失敗。請在下方文字框 Ctrl+A → Ctrl+C 複製完整程式（不是嵌入網址）。LOG_SHEET_ID=${res.logSpreadsheetId}`;
            }
        }

        async function exportSitesTrackerFile() {
            const hint = document.getElementById('sites-visits-hint');
            const res = await window.api.sitesVisitsExportTracker();
            if (!res?.success) {
                if (hint) hint.textContent = res?.error || '匯出失敗';
                return;
            }
            if (hint) hint.textContent = res.message || `已匯出：${res.path}`;
        }

        async function clearSitesVisitsLocal() {
            const hint = document.getElementById('sites-visits-hint');
            const res = await window.api.sitesVisitsClearLocal();
            if (!res?.success) {
                if (hint) hint.textContent = res?.error || '清除失敗';
                return;
            }
            if (hint) {
                hint.textContent = (res.message || '已清除本機快取') + '。若仍看到舊專案名，請到試算表刪除「網站ID」等測試列。';
            }
            if (document.getElementById('sites-visits-list')) loadSitesVisits();
        }

        async function renderSheetSources() {
            const box = document.getElementById('sheet-source-list');
            if (!box || !window.api.sheetsListSources) return;
            const res = await window.api.sheetsListSources();
            const sources = res.sources || [];
            box.innerHTML = sources.map(s => `
                <div class="sheet-source-row">
                    <span title="${escapeHtml(s.url || s.spreadsheetId || '')}">${escapeHtml(s.name)}（已綁死）</span>
                </div>
            `).join('');
            const hint = document.getElementById('sheet-settings-hint');
            if (hint) {
                hint.textContent = '已綁死 9527。請用「加入功能 → 加入9527」放到工作台。';
            }
        }

        async function openSheetsApiSetup() {
            const res = await window.api.sheetsOpenSetup();
            const hint = document.getElementById('sheet-settings-hint');
            if (hint) hint.textContent = '已打開 Google Cloud。請按「啟用／ENABLE」，等約一分鐘後再按「授權 Google 試算表」。';
            return res;
        }

        async function ensureSheetsReadyAfterLogin() {
            const status = await window.api.sheetsStatus();
            if (status?.needsApi) {
                await openSheetsApiSetup();
                alert('登入不會出現試算表授權，是因為 Google Cloud 還沒啟用 Sheets API。\n\n已打開啟用頁，請按「啟用／ENABLE」。\n完成約一分鐘後，到齒輪按「授權 Google 試算表」。');
                return false;
            }
            if (status?.featureScopeMissing || status?.needsAuth) {
                return authorizeSheets();
            }
            return true;
        }

        function showSheetsError(res) {
            if (res?.needsApi) openSheetsApiSetup();
            alert(res?.error || '無法使用試算表');
            const hint = document.getElementById('sheet-settings-hint');
            if (hint && res?.error) hint.textContent = res.error;
        }

        async function authorizeSheets() {
            const hint = document.getElementById('sheet-settings-hint');
            if (hint) hint.textContent = '正在打開 Google 授權頁，請允許「查看、編輯 Google 試算表」…';
            const ok = await authorizeFeature('sheets');
            if (!ok) {
                if (hint) hint.textContent = '授權失敗';
                return false;
            }
            if (hint) hint.textContent = '試算表授權完成，可以再加入來源。';
            return true;
        }

        async function addSheetSource() {
            const name = document.getElementById('sheet-name')?.value.trim() || '';
            const url = document.getElementById('sheet-url')?.value.trim() || '';
            let res = await window.api.sheetsAddSource({ name, url });
            if (res?.needsReauth || res?.featureScopeMissing || res?.needsAuth || res?.authRevoked) {
                const ok = await authorizeSheets();
                if (!ok) return;
                res = await window.api.sheetsAddSource({ name, url });
            }
            if (!res?.success) {
                showSheetsError(res);
                return;
            }
            document.getElementById('sheet-name').value = '';
            document.getElementById('sheet-url').value = '';
            await renderSheetSources();
            if (document.getElementById('sheets-list')) loadSheets();
        }

        async function removeSheetSource(id) {
            const res = await window.api.sheetsRemoveSource(id);
            if (!res?.success) {
                alert(res?.error || '無法移除');
                return;
            }
            await renderSheetSources();
            if (document.getElementById('sheets-list')) loadSheets();
        }

        applyTheme(localStorage.getItem('theme') || 'light');
        applyFontScale(localStorage.getItem(FONT_SCALE_KEY) || 1, { persist: false });
        (async () => {
            try {
                const res = await window.api.getAppFontScale?.();
                if (res?.scale != null) applyFontScale(res.scale, { persist: false });
            } catch (_) {}
        })();
        markGchatReplyIconsMaterial();

        let chatHistory = [];

        function showChatView(view) {
            const main = document.getElementById('chat-main');
            const kb = document.getElementById('chat-kb');
            const settings = document.getElementById('chat-settings');
            if (!main) return;
            main.style.display = view === 'chat' ? 'flex' : 'none';
            kb?.classList.toggle('open', view === 'kb');
            settings?.classList.toggle('open', view === 'settings');
            if (view === 'kb') renderKnowledgeList();
            if (view === 'settings') loadGeminiSettings();
        }


        // ========== 【FEATURE: chat】詢問機器人 ==========
        async function mountChat() {
            const log = document.getElementById('chat-log');
            if (log && !(await ensureFeatureAuthorized('chat'))) {
                paintFeatureAuthGate(log, 'chat', '詢問機器人');
                return;
            }
            showChatView('chat');
            await renderKnowledgeList();
            await loadGeminiSettings();
        }

        async function loadGeminiSettings() {
            const res = await window.api.geminiGetConfig();
            const project = document.getElementById('gemini-project');
            const location = document.getElementById('gemini-location');
            const model = document.getElementById('gemini-model');
            const status = document.getElementById('gemini-status');
            const sqlConn = document.getElementById('sql-connection-string');
            const sqlServer = document.getElementById('sql-server');
            const sqlPort = document.getElementById('sql-port');
            const sqlDatabase = document.getElementById('sql-database');
            const sqlTable = document.getElementById('sql-table');
            const sqlUser = document.getElementById('sql-user');
            const sqlPassword = document.getElementById('sql-password');
            if (!project || !res.success) return;
            project.value = res.projectId || '';
            if (location) {
                const loc = res.location || 'us-central1';
                if (![...location.options].some(o => o.value === loc)) {
                    location.add(new Option(loc, loc));
                }
                location.value = loc;
            }
            if (model) model.value = res.model || 'gemini-2.5-flash';
            if (sqlConn) sqlConn.value = res.sqlConnectionString || '';
            if (sqlServer) sqlServer.value = res.sqlServer || '';
            if (sqlPort) sqlPort.value = res.sqlPort || 1433;
            if (sqlDatabase) sqlDatabase.value = res.sqlDatabase || 'erp';
            if (sqlTable) sqlTable.value = res.sqlTable || 'dbo.EMRequestForm';
            if (sqlUser) sqlUser.value = res.sqlUser || '';
            if (sqlPassword) sqlPassword.placeholder = res.hasSqlPassword ? '已儲存密碼，若要更換再填' : '貼上密碼';
            if (status) {
                if (!res.sqlConnectionString && !res.sqlServer) status.textContent = '請填入 SQL 連線字串，提問才會查 EMRequestForm。';
                else if (!res.loggedIn && !res.projectId) status.textContent = 'SQL 已設定。回答還需要 Google 登入與 Gemini 專案 ID。';
                else status.textContent = '已設定。提問會先查 SQL 問題單，再交給 Gemini 回答。';
            }
        }

        async function toggleOpenAtLogin(enabled) {
            const checkbox = document.getElementById('open-at-login');
            const res = await window.api.setOpenAtLogin(!!enabled);
            if (!res?.success) {
                if (checkbox) checkbox.checked = !enabled;
                alert('無法變更開機自動啟動：' + (res?.error || '未知錯誤'));
                return;
            }
            if (checkbox) checkbox.checked = !!res.openAtLogin;
        }

        async function saveGeminiSettings() {
            const projectId = document.getElementById('gemini-project')?.value.trim() || '';
            const location = document.getElementById('gemini-location')?.value.trim() || 'us-central1';
            const model = document.getElementById('gemini-model')?.value.trim() || 'gemini-2.5-flash';
            const sqlPassword = document.getElementById('sql-password')?.value || '';
            await window.api.geminiSaveConfig({
                projectId,
                location,
                model,
                sqlConnectionString: document.getElementById('sql-connection-string')?.value.trim() || '',
                sqlServer: document.getElementById('sql-server')?.value.trim() || '',
                sqlPort: Number(document.getElementById('sql-port')?.value) || 1433,
                sqlDatabase: document.getElementById('sql-database')?.value.trim() || 'erp',
                sqlTable: document.getElementById('sql-table')?.value.trim() || 'dbo.EMRequestForm',
                sqlUser: document.getElementById('sql-user')?.value.trim() || '',
                sqlPassword: sqlPassword || undefined
            });
            if (document.getElementById('sql-password')) document.getElementById('sql-password').value = '';
            alert('設定已儲存');
            showChatView('chat');
        }

        async function renderKnowledgeList() {
            const box = document.getElementById('kb-list');
            if (!box) return;
            const res = await window.api.knowledgeList();
            const files = res.files || [];
            if (!files.length) {
                box.innerHTML = `<div class="loading">還沒有資料。請加入 txt、md、csv、json 檔。</div>`;
                return;
            }
            box.innerHTML = files.map(f => `
                <div class="kb-item">
                    <span>${escapeHtml(f.name)} · ${(f.chars || 0).toLocaleString()} 字</span>
                    <button class="link-btn" onclick="removeKnowledge('${f.id}')">移除</button>
                </div>
            `).join('');
        }

        async function addKnowledgeFiles() {
            const res = await window.api.knowledgeAdd();
            if (res.success) renderKnowledgeList();
        }

        async function removeKnowledge(id) {
            await window.api.knowledgeRemove(id);
            renderKnowledgeList();
        }

        function onChatKey(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendChat();
            }
        }

        function appendChat(role, text, sources) {
            const log = document.getElementById('chat-log');
            if (!log) return;
            const div = document.createElement('div');
            div.className = `chat-bubble ${role === 'assistant' ? 'bot' : 'user'}`;
            div.textContent = text;
            if (sources?.length) {
                const src = document.createElement('span');
                src.className = 'chat-sources';
                src.textContent = '來源：' + sources.join('、');
                div.appendChild(src);
            }
            log.appendChild(div);
            log.scrollTop = log.scrollHeight;
        }

        function appendRetrieved(result) {
            const log = document.getElementById('chat-log');
            if (!log) return;
            const div = document.createElement('div');
            div.className = 'chat-bubble bot retrieved';
            const files = result.files || [];
            const snippets = result.snippets || [];
            let title = 'SQL 沒有撈到相關問題單。';
            if (files.length) {
                title = `已查詢 EMRequestForm，撈到 ${snippets.length} 筆：${files.join('、')}`;
            }
            const details = document.createElement('details');
            details.open = true;
            const summary = document.createElement('summary');
            summary.textContent = title;
            details.appendChild(summary);
            if (result.api) {
                const apiLine = document.createElement('div');
                apiLine.className = 'chat-excerpt';
                apiLine.textContent = `API：${result.api}`;
                details.appendChild(apiLine);
            }
            if (snippets.length) {
                snippets.forEach(s => {
                    const p = document.createElement('div');
                    p.className = 'chat-excerpt';
                    p.textContent = `【${s.name}】\n${s.excerpt}${s.chars > (s.excerpt || '').length ? '…' : ''}`;
                    details.appendChild(p);
                });
            }
            div.appendChild(details);
            log.appendChild(div);
            log.scrollTop = log.scrollHeight;
        }

        async function sendChat() {
            const input = document.getElementById('chat-input');
            const btn = document.getElementById('chat-send');
            const question = input?.value.trim();
            if (!question) return;
            input.value = '';
            appendChat('user', question);
            chatHistory.push({ role: 'user', text: question });
            btn.disabled = true;
            btn.textContent = '撈取中';
            const found = await window.api.knowledgeSearch(question);
            if (!found?.success) {
                btn.disabled = false;
                btn.textContent = '送出';
                appendChat('assistant', 'SQL 查詢失敗：' + (found?.error || '未知錯誤'));
                return;
            }
            appendRetrieved(found);
            btn.textContent = '回答中';
            const res = await window.api.chatAsk({ question, history: chatHistory.slice(0, -1) });
            btn.disabled = false;
            btn.textContent = '送出';
            if (!res.success) {
                appendChat('assistant', '無法回答：' + res.error);
                return;
            }
            appendChat('assistant', res.text, res.sources);
            chatHistory.push({ role: 'assistant', text: res.text });
        }


        // ========== 【MODULE: Authorization】登出 ==========
        function logoutApp() { if (confirm('即將清除登入紀錄並重啟，確定嗎？')) window.api.logout(); }

        if (window.api.onGmailPacket) {
            window.api.onGmailPacket((packet) => applyGmailPacket(packet, { silent: true }));
        }
    