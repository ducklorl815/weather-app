'use strict';

/**
 * Google Drive 資料夾輔助（Folder ID／建立／列表）
 * drive.file 無法任意瀏覽全部資料夾；優先：貼上 ID／URL、建立 App 資料夾、列出 App 可見資料夾。
 */
function parseDriveFolderId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const folderMatch = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];
  const idMatch = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return s;
}

function createDriveFolderHelpers({
  getDriveService,
  withGoogleApiRetry,
  assertDriveReady
}) {
  async function resolveFolder(rawIdOrUrl) {
    await assertDriveReady();
    const drive = getDriveService();
    const folderId = parseDriveFolderId(rawIdOrUrl);
    if (!folderId) throw new Error('請提供 Google Drive 資料夾 ID 或網址');
    try {
      const res = await withGoogleApiRetry(() => drive.files.get({
        fileId: folderId,
        fields: 'id,name,mimeType,trashed'
      }));
      const data = res.data || {};
      if (data.trashed) throw new Error('此資料夾已在垃圾桶');
      if (data.mimeType && data.mimeType !== 'application/vnd.google-apps.folder') {
        throw new Error('此 ID 不是資料夾');
      }
      return {
        folderId: data.id || folderId,
        folderName: data.name || folderId
      };
    } catch (err) {
      if (/File not found|not found|404/i.test(err.message || '')) {
        throw new Error(
          '找不到資料夾（drive.file 僅能存取 App 建立或曾授權的資料夾）。可改用「建立資料夾」，或貼上 App 可見的 Folder ID。'
        );
      }
      throw err;
    }
  }

  async function createFolder(name, parentId) {
    await assertDriveReady();
    const drive = getDriveService();
    const folderName = String(name || '').trim() || `LifeTour Reports ${new Date().toISOString().slice(0, 10)}`;
    const requestBody = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    };
    const parent = String(parentId || '').trim();
    if (parent) requestBody.parents = [parent];
    const res = await withGoogleApiRetry(() => drive.files.create({
      requestBody,
      fields: 'id,name'
    }));
    if (!res.data?.id) throw new Error('建立資料夾失敗');
    return {
      folderId: res.data.id,
      folderName: res.data.name || folderName
    };
  }

  async function listFolders({ pageSize = 50 } = {}) {
    await assertDriveReady();
    const drive = getDriveService();
    const res = await withGoogleApiRetry(() => drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id,name,createdTime)',
      pageSize: Math.min(100, Math.max(1, pageSize)),
      orderBy: 'modifiedTime desc',
      spaces: 'drive'
    }));
    return (res.data?.files || []).map((f) => ({
      folderId: f.id,
      folderName: f.name || f.id
    }));
  }

  return {
    parseDriveFolderId,
    resolveFolder,
    createFolder,
    listFolders
  };
}

module.exports = { createDriveFolderHelpers, parseDriveFolderId };
