'use strict';

/**
 * LifeTour 雲端硬碟標準路徑
 * ----------------------------------------------------------------------------
 * 我的雲端硬碟/LifeTourTools/記事
 * 我的雲端硬碟/LifeTourTools/SQL報表
 *
 * [Important] drive.file 僅能可靠存取 App 建立或曾授權的資料夾；
 * 找不到同名資料夾時會新建。
 */

const ROOT_FOLDER_NAME = 'LifeTourTools';
const NOTES_FOLDER_NAME = '記事';
const SQL_REPORTS_FOLDER_NAME = 'SQL報表';

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * @param {{ getDriveService: Function, withGoogleApiRetry: Function }} deps
 */
function createLifeTourDriveFolders(deps) {
  async function getDrive() {
    const drive = deps.getDriveService?.();
    if (!drive) {
      const err = new Error('請先用 Google 登入');
      err.needsAuth = true;
      throw err;
    }
    return drive;
  }

  async function findChildFolder(parentId, name) {
    const drive = await getDrive();
    const parentClause = parentId ? `'${escapeDriveQueryValue(parentId)}' in parents` : `'root' in parents`;
    const q = [
      parentClause,
      "mimeType='application/vnd.google-apps.folder'",
      `name='${escapeDriveQueryValue(name)}'`,
      'trashed=false'
    ].join(' and ');
    const res = await deps.withGoogleApiRetry(() => drive.files.list({
      q,
      fields: 'files(id,name)',
      pageSize: 5,
      spaces: 'drive'
    }));
    return res.data?.files?.[0] || null;
  }

  async function createChildFolder(parentId, name) {
    const drive = await getDrive();
    const requestBody = {
      name,
      mimeType: 'application/vnd.google-apps.folder'
    };
    if (parentId) requestBody.parents = [parentId];
    const res = await deps.withGoogleApiRetry(() => drive.files.create({
      requestBody,
      fields: 'id,name'
    }));
    if (!res.data?.id) throw new Error(`無法建立資料夾：${name}`);
    return { id: res.data.id, name: res.data.name || name };
  }

  async function ensureChildFolder(parentId, name) {
    const found = await findChildFolder(parentId, name);
    if (found?.id) return { id: found.id, name: found.name || name, created: false };
    const created = await createChildFolder(parentId, name);
    return { ...created, created: true };
  }

  /** 確保 LifeTourTools 存在，回傳其 folderId */
  async function ensureRootFolder() {
    return ensureChildFolder(null, ROOT_FOLDER_NAME);
  }

  async function ensureNotesFolder() {
    const root = await ensureRootFolder();
    const folder = await ensureChildFolder(root.id, NOTES_FOLDER_NAME);
    return { rootId: root.id, folderId: folder.id, folderName: folder.name, path: `${ROOT_FOLDER_NAME}/${NOTES_FOLDER_NAME}` };
  }

  async function ensureSqlReportsFolder() {
    const root = await ensureRootFolder();
    const folder = await ensureChildFolder(root.id, SQL_REPORTS_FOLDER_NAME);
    return { rootId: root.id, folderId: folder.id, folderName: folder.name, path: `${ROOT_FOLDER_NAME}/${SQL_REPORTS_FOLDER_NAME}` };
  }

  /** 把檔案移到指定資料夾（移除舊 parents） */
  async function moveFileToFolder(fileId, folderId) {
    const drive = await getDrive();
    const id = String(fileId || '').trim();
    const dest = String(folderId || '').trim();
    if (!id || !dest) return { moved: false };
    const meta = await deps.withGoogleApiRetry(() => drive.files.get({
      fileId: id,
      fields: 'id,parents'
    }));
    const parents = meta.data?.parents || [];
    if (parents.includes(dest) && parents.length === 1) {
      return { moved: false, already: true };
    }
    const removeParents = parents.filter((p) => p !== dest).join(',');
    await deps.withGoogleApiRetry(() => drive.files.update({
      fileId: id,
      addParents: dest,
      removeParents: removeParents || undefined,
      fields: 'id,parents'
    }));
    return { moved: true };
  }

  return {
    ROOT_FOLDER_NAME,
    NOTES_FOLDER_NAME,
    SQL_REPORTS_FOLDER_NAME,
    ensureRootFolder,
    ensureNotesFolder,
    ensureSqlReportsFolder,
    moveFileToFolder
  };
}

module.exports = {
  createLifeTourDriveFolders,
  ROOT_FOLDER_NAME,
  NOTES_FOLDER_NAME,
  SQL_REPORTS_FOLDER_NAME
};
