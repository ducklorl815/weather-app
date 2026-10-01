'use strict';

const { createLocalFileOutputProvider } = require('./local-provider');
const { createGoogleDriveOutputProvider } = require('./google-drive-provider');

function createOutputFactory({
  fs,
  path,
  getDriveService,
  withGoogleApiRetry,
  assertDriveReady
}) {
  const local = createLocalFileOutputProvider({ fs, path });
  const drive = createGoogleDriveOutputProvider({
    getDriveService,
    withGoogleApiRetry,
    assertDriveReady
  });

  function getProvider(outputType) {
    if (outputType === 'Local') return local;
    if (outputType === 'GoogleDrive') return drive;
    throw new Error(`不支援的輸出類型：${outputType}`);
  }

  return { getProvider };
}

module.exports = { createOutputFactory };
