'use strict';

function createLocalFileOutputProvider({ fs, path }) {
  async function write(tempFilePath, fileName, context) {
    const localPath = String(context.outputConfig?.localPath || '').trim();
    if (!localPath) throw new Error('未設定本機輸出路徑');

    let targetDir = localPath;
    if (context.executionType === 'Test') {
      targetDir = path.join(localPath, 'Test');
    }

    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      throw new Error(`無法建立輸出資料夾：${err.message}`);
    }

    let finalName = fileName;
    let targetPath = path.join(targetDir, finalName);
    const mode = context.overwriteMode || 'Overwrite';

    if (mode === 'FailIfExists' && fs.existsSync(targetPath)) {
      throw new Error(`檔案已存在：${finalName}`);
    }

    if (mode === 'AppendTimestamp' && fs.existsSync(targetPath)) {
      // fileName 已在 export-service 依 mode 產生；此處僅防呆
    }

    if (mode === 'Overwrite' && fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(targetPath);
      } catch (err) {
        throw new Error(`無法覆蓋既有檔案：${err.message}`);
      }
    }

    try {
      fs.copyFileSync(tempFilePath, targetPath);
    } catch (err) {
      throw new Error(`寫入檔案失敗：${err.message}`);
    }

    return {
      fileName: finalName,
      filePath: targetPath,
      destinationType: 'Local'
    };
  }

  return { type: 'Local', write };
}

module.exports = { createLocalFileOutputProvider };
