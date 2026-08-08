// Bounded ExcelJS adapter used by runtime imports and synthetic workbook generation.

const ExcelJS = require('exceljs');

const MAX_WORKSHEETS = Number(process.env.EXCEL_MAX_WORKSHEETS) || 10;
const MAX_ROWS = Number(process.env.EXCEL_MAX_ROWS) || 50000;
const MAX_COLUMNS = Number(process.env.EXCEL_MAX_COLUMNS) || 100;

function plainCellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'result')) return plainCellValue(value.result);
  if (Array.isArray(value.richText)) return value.richText.map(item => item.text || '').join('');
  if (Object.prototype.hasOwnProperty.call(value, 'text')) return String(value.text || '');
  if (Object.prototype.hasOwnProperty.call(value, 'hyperlink')) return String(value.text || value.hyperlink || '');
  return String(value);
}

async function loadWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Excel file is empty.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (!workbook.worksheets.length) throw new Error('Excel workbook has no worksheets.');
  if (workbook.worksheets.length > MAX_WORKSHEETS) {
    throw new Error(`Excel workbook exceeds ${MAX_WORKSHEETS} worksheets.`);
  }
  for (const worksheet of workbook.worksheets) {
    if (worksheet.actualRowCount > MAX_ROWS || worksheet.rowCount > MAX_ROWS) {
      throw new Error(`Worksheet "${worksheet.name}" exceeds ${MAX_ROWS} rows.`);
    }
    if (worksheet.actualColumnCount > MAX_COLUMNS || worksheet.columnCount > MAX_COLUMNS) {
      throw new Error(`Worksheet "${worksheet.name}" exceeds ${MAX_COLUMNS} columns.`);
    }
  }
  return workbook;
}

function worksheetRows(worksheet) {
  if (!worksheet) return [];
  const rowCount = Math.min(worksheet.rowCount, MAX_ROWS);
  const columnCount = Math.min(Math.max(worksheet.actualColumnCount, worksheet.columnCount), MAX_COLUMNS);
  const rows = [];
  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const values = [];
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      values.push(plainCellValue(row.getCell(columnIndex).value));
    }
    rows.push(values);
  }
  return rows;
}

function requireSheet(workbook, preferredName) {
  const worksheet = workbook.getWorksheet(preferredName) || workbook.worksheets[0];
  if (!worksheet || worksheet.actualRowCount < 1) throw new Error('Excel worksheet is empty.');
  return worksheet;
}

async function writeWorkbook(filePath, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows || []) worksheet.addRow(row);
  }
  await workbook.xlsx.writeFile(filePath);
}

module.exports = {
  loadWorkbook,
  worksheetRows,
  requireSheet,
  writeWorkbook,
};
