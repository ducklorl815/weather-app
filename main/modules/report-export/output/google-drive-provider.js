'use strict';

const { createReadStream } = require('fs');

function escapeDriveQueryValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function createGoogleDriveOutputProvider({
  getDriveService,
  withGoogleApiRetry,
  assertDriveReady
}) {
  async function findFileInFolder(drive, folderId, fileName) {
    const q = [
      `name='${escapeDriveQueryValue(fileName)}'`,
      `'${escapeDriveQueryValue(folderId)}' in parents`,
      'trashed=false'
    ].join(' and ');
    const res = await withGoogleApiRetry(() => drive.files.list({
      q,
      fields: 'files(id,name)',
      pageSize: 10,
      spaces: 'drive'
    }));
    const files = res.data?.files || [];
    return files[0] || null;
  }

  async function write(tempFilePath, fileName, context) {
    await assertDriveReady();
    const drive = getDriveService();
    if (!drive) throw new Error('雲端硬碟服務尚未就緒，請先登入 Google');

    const cfg = context.outputConfig || {};
    let folderId = String(cfg.folderId || '').trim();
    if (context.executionType === 'Test') {
      folderId = String(cfg.testFolderId || '').trim();
      if (!folderId) {
        throw new Error('測試產生請先設定 Google Drive「測試資料夾」Folder ID');
      }
    }
    if (!folderId) throw new Error('未設定 Google Drive 資料夾');

    const mode = context.overwriteMode || 'Overwrite';
    const existing = await findFileInFolder(drive, folderId, fileName);

    if (mode === 'FailIfExists' && existing) {
      throw new Error(`Google Drive 檔案已存在：${fileName}`);
    }

    let fileId = null;
    if (mode === 'Overwrite' && existing?.id) {
      const updated = await withGoogleApiRetry(() => drive.files.update({
        fileId: existing.id,
        media: {
          mimeType: 'text/csv',
          body: createReadStream(tempFilePath)
        },
        fields: 'id,name'
      }));
      fileId = updated.data?.id || existing.id;
    } else {
      // AppendTimestamp 檔名已含時間；或 Overwrite 找不到舊檔 → create
      const created = await withGoogleApiRetry(() => drive.files.create({
        requestBody: {
          name: fileName,
          parents: [folderId],
          mimeType: 'text/csv'
        },
        media: {
          mimeType: 'text/csv',
          body: createReadStream(tempFilePath)
        },
        fields: 'id,name'
      }));
      fileId = created.data?.id;
      if (!fileId) throw new Error('上傳 Google Drive 失敗（未取得 File ID）');
    }

    return {
      fileName,
      destinationType: 'GoogleDrive',
      googleDriveFolderId: folderId,
      googleDriveFileId: fileId
    };
  }

  return { type: 'GoogleDrive', write };
}

module.exports = { createGoogleDriveOutputProvider, escapeDriveQueryValue };
