'use strict';

/** RFC 4180 風格 CSV 欄位 escape */
function escapeCsvField(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function createCsvWriter({ useBom = true } = {}) {
  function headerLine(columns) {
    return columns.map((c) => escapeCsvField(c)).join(',');
  }

  function dataLine(columns, row, serializeCell) {
    return columns.map((col) => escapeCsvField(serializeCell(row[col]))).join(',');
  }

  /**
   * 寫入完整 CSV 檔（含 optional BOM）。
   * @returns {{ bytesWritten: number }}
   */
  function writeFile({ filePath, columns, rows, serializeCell, fs }) {
    const lines = [headerLine(columns)];
    for (const row of rows) {
      lines.push(dataLine(columns, row, serializeCell));
    }
    const body = lines.join('\r\n') + '\r\n';
    const content = (useBom ? '\uFEFF' : '') + body;
    fs.writeFileSync(filePath, content, 'utf8');
    return { bytesWritten: Buffer.byteLength(content, 'utf8') };
  }

  /**
   * 串流寫入：先寫 header，再逐列 append。
   */
  function createStreamingFile({ filePath, columns, serializeCell, fs }) {
    const fd = fs.openSync(filePath, 'w');
    let bytesWritten = 0;
    const write = (chunk) => {
      const buf = Buffer.from(chunk, 'utf8');
      fs.writeSync(fd, buf);
      bytesWritten += buf.length;
    };
    if (useBom) write('\uFEFF');
    write(headerLine(columns) + '\r\n');
    return {
      writeRow(row) {
        write(dataLine(columns, row, serializeCell) + '\r\n');
      },
      close() {
        fs.closeSync(fd);
        return { bytesWritten };
      }
    };
  }

  return {
    escapeCsvField,
    headerLine,
    dataLine,
    writeFile,
    createStreamingFile,
    useBom
  };
}

module.exports = { createCsvWriter, escapeCsvField };
