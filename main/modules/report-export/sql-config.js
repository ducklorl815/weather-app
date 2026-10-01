'use strict';

/**
 * 報表匯出 SQL 連線：測試 / 正式 雙設定
 * - 發布包（packaged）：一律使用 test
 * - npm start 開發者模式：可編輯兩套，並可切換 activeProfile
 * 與詢問機器人共用：test 會同步回 gemini.json 既有 sql* 欄位
 */

function emptySqlProfile() {
  return {
    sqlConnectionString: '',
    sqlServer: '',
    sqlPort: 1433,
    sqlDatabase: '',
    sqlUser: '',
    sqlPassword: '',
    sqlEncrypt: false,
    sqlTrustCert: true
  };
}

function profileFromLegacy(cfg) {
  const c = cfg || {};
  return {
    sqlConnectionString: String(c.sqlConnectionString || '').trim(),
    sqlServer: String(c.sqlServer || '').trim(),
    sqlPort: Number(c.sqlPort) || 1433,
    sqlDatabase: String(c.sqlDatabase || '').trim(),
    sqlUser: String(c.sqlUser || '').trim(),
    sqlPassword: c.sqlPassword || '',
    sqlEncrypt: !!c.sqlEncrypt,
    sqlTrustCert: c.sqlTrustCert !== false
  };
}

function normalizeProfile(raw, fallbackPassword) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = emptySqlProfile();
  const password = (src.sqlPassword === undefined || src.sqlPassword === '')
    ? (fallbackPassword || '')
    : src.sqlPassword;
  return {
    sqlConnectionString: src.sqlConnectionString === undefined
      ? base.sqlConnectionString
      : String(src.sqlConnectionString || '').trim(),
    sqlServer: src.sqlServer === undefined ? base.sqlServer : String(src.sqlServer || '').trim(),
    sqlPort: src.sqlPort === undefined ? base.sqlPort : (Number(src.sqlPort) || 1433),
    sqlDatabase: src.sqlDatabase === undefined ? base.sqlDatabase : String(src.sqlDatabase || '').trim(),
    sqlUser: src.sqlUser === undefined ? base.sqlUser : String(src.sqlUser || '').trim(),
    sqlPassword: password,
    sqlEncrypt: src.sqlEncrypt === undefined ? base.sqlEncrypt : !!src.sqlEncrypt,
    sqlTrustCert: src.sqlTrustCert === undefined ? true : !!src.sqlTrustCert
  };
}

function ensureProfiles(cfg) {
  const c = cfg || {};
  let test;
  let production;
  if (c.sqlProfiles?.test) {
    test = normalizeProfile(c.sqlProfiles.test, c.sqlProfiles.test.sqlPassword);
  } else {
    test = profileFromLegacy(c);
  }
  if (c.sqlProfiles?.production) {
    production = normalizeProfile(c.sqlProfiles.production, c.sqlProfiles.production.sqlPassword);
  } else {
    production = emptySqlProfile();
  }
  const activeProfile = c.reportSqlActiveProfile === 'production' ? 'production' : 'test';
  return { test, production, activeProfile };
}

function publicProfileView(profile) {
  return {
    sqlConnectionString: profile.sqlConnectionString || '',
    hasSqlConnectionString: !!profile.sqlConnectionString,
    sqlServer: profile.sqlServer || '',
    sqlPort: profile.sqlPort || 1433,
    sqlDatabase: profile.sqlDatabase || '',
    sqlUser: profile.sqlUser || '',
    hasSqlPassword: !!profile.sqlPassword,
    sqlEncrypt: !!profile.sqlEncrypt,
    sqlTrustCert: profile.sqlTrustCert !== false
  };
}

/**
 * @param {{ loadGeminiConfig: Function, saveGeminiConfig: Function, isPackaged: () => boolean }} deps
 */
function createReportSqlConfigService(deps) {
  function read() {
    const cfg = deps.loadGeminiConfig() || {};
    return ensureProfiles(cfg);
  }

  function resolveActiveKey() {
    if (deps.isPackaged()) return 'test';
    const { activeProfile } = read();
    return activeProfile === 'production' ? 'production' : 'test';
  }

  /**
   * 給 getSqlPool 用的連線 cfg（只含 SQL 欄位）
   * @param {'test'|'production'|undefined} profileOverride 指定 profile；未指定則依 activeProfile／packaged
   */
  function resolvePoolConfig(profileOverride) {
    const all = read();
    let key;
    if (profileOverride === 'test' || profileOverride === 'production') {
      key = profileOverride;
    } else {
      key = resolveActiveKey();
    }
    return { ...all[key], _reportSqlProfile: key };
  }

  /** 依執行類型決定 SQL profile（預覽／測試→test；手動／排程→production 或 packaged 固定 test） */
  function resolveProfileForExecution(executionType) {
    const packaged = !!deps.isPackaged();
    if (executionType === 'Preview' || executionType === 'Test') return 'test';
    if (executionType === 'Manual' || executionType === 'Schedule') {
      return packaged ? 'test' : 'production';
    }
    return packaged ? 'test' : 'production';
  }

  function getPublicState() {
    const all = read();
    const packaged = !!deps.isPackaged();
    return {
      success: true,
      isDev: !packaged,
      packaged,
      activeProfile: packaged ? 'test' : all.activeProfile,
      forcedProfile: packaged ? 'test' : null,
      test: publicProfileView(all.test),
      production: publicProfileView(all.production)
    };
  }

  function save({ profile, activeProfile, ...fields } = {}) {
    if (deps.isPackaged()) {
      throw new Error('正式安裝包不可修改 SQL 連線（僅開發者模式）');
    }
    const key = profile === 'production' ? 'production' : 'test';
    const current = read();
    const prev = current[key];
    const nextProfile = normalizeProfile(
      { ...prev, ...fields },
      // 密碼空白＝保留
      (fields.sqlPassword === undefined || fields.sqlPassword === '')
        ? prev.sqlPassword
        : fields.sqlPassword
    );
    const nextActive = activeProfile === 'production' || activeProfile === 'test'
      ? activeProfile
      : current.activeProfile;

    const nextProfiles = {
      test: key === 'test' ? nextProfile : current.test,
      production: key === 'production' ? nextProfile : current.production
    };

    // 同步 test → 舊欄位，讓詢問機器人沿用測試庫
    const sync = nextProfiles.test;
    deps.saveGeminiConfig({
      sqlProfiles: nextProfiles,
      reportSqlActiveProfile: nextActive,
      sqlConnectionString: sync.sqlConnectionString,
      sqlServer: sync.sqlServer,
      sqlPort: sync.sqlPort,
      sqlDatabase: sync.sqlDatabase,
      sqlUser: sync.sqlUser,
      sqlPassword: sync.sqlPassword,
      sqlEncrypt: sync.sqlEncrypt,
      sqlTrustCert: sync.sqlTrustCert
    });
    return getPublicState();
  }

  function setActiveProfile(profile) {
    if (deps.isPackaged()) {
      throw new Error('正式安裝包固定使用測試連線');
    }
    const key = profile === 'production' ? 'production' : 'test';
    const current = read();
    deps.saveGeminiConfig({
      sqlProfiles: { test: current.test, production: current.production },
      reportSqlActiveProfile: key
    });
    return getPublicState();
  }

  return {
    read,
    resolveActiveKey,
    resolvePoolConfig,
    resolveProfileForExecution,
    getPublicState,
    save,
    setActiveProfile
  };
}

module.exports = {
  createReportSqlConfigService,
  emptySqlProfile,
  ensureProfiles,
  publicProfileView
};
