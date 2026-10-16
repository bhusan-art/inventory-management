import { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import { streamCsv, streamXlsx } from '../../src/services/reports/exportService.js';

/**
 * These exercise the real writers.
 *
 * They exist because 206 unit tests passed while the XLSX export was broken: a
 * single bad assignment (`sheet.views = [...]`, which throws on a streaming
 * worksheet) killed every download, and nothing in the unit suite ever built a
 * workbook. The column-permission tests checked the DECISION about columns and
 * never the act of writing them.
 *
 * A mock response collects the bytes, so no database or HTTP server is needed
 * and the whole path from column list to parsed file is covered. The audit
 * write inside the export has no database here; `writeAudit` catches and logs
 * its own failures, and `tests/setup.js` shortens Mongoose's buffer timeout so
 * that happens promptly instead of after ten seconds per call.
 */
function mockResponse() {
  const chunks = [];
  const headers = {};

  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });

  res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
  res.getHeader = (k) => headers[k.toLowerCase()];
  res.headers = headers;
  res.buffer = () => Buffer.concat(chunks);
  res.text = () => Buffer.concat(chunks).toString('utf8');

  return res;
}

const actor = {
  tenantId: '6acf10dd84f6247fbfa73783',
  id: '6acf10dd84f6247fbfa73784',
  permissions: new Set(),
};

const columns = [
  { key: 'serial', header: 'Serial' },
  { key: 'qty', header: 'Qty', type: 'number' },
  { key: 'received', header: 'Received', type: 'date' },
  { key: 'phone', header: 'Phone', model: 'Customer', field: 'phone' },
];

const rows = [
  { serial: '123456789012345', qty: 5, received: new Date('2026-09-10'), phone: '+919876543210' },
  { serial: 'SN-2', qty: -3, received: new Date('2026-10-01'), phone: '+919812345678' },
];

describe('CSV streaming', () => {
  it('writes a parsable file with the restricted column removed', async () => {
    const res = mockResponse();
    const written = await streamCsv({
      res, columns, cursor: rows, filename: 'test', actor, reportName: 'Test',
    });

    expect(written).toBe(2);

    const text = res.text();
    const lines = text.replace('﻿', '').trim().split('\n');

    expect(lines[0]).toBe('Serial,Qty,Received');
    expect(lines[0]).not.toContain('Phone');
    expect(text).not.toContain('9876543210');
    expect(lines).toHaveLength(3);
  });

  it('keeps a negative quantity a number and defuses nothing it should not', async () => {
    const res = mockResponse();
    await streamCsv({ res, columns, cursor: rows, filename: 't', actor, reportName: 'T' });

    // -3 is a number, so it must not acquire the injection apostrophe.
    expect(res.text()).toContain(',-3,');
  });

  it('sets download headers rather than inline ones', async () => {
    const res = mockResponse();
    await streamCsv({ res, columns, cursor: rows, filename: 'my report', actor, reportName: 'T' });

    expect(res.getHeader('content-type')).toMatch(/text\/csv/);
    expect(res.getHeader('content-disposition')).toBe('attachment; filename="my-report.csv"');
    expect(res.getHeader('x-content-type-options')).toBe('nosniff');
  });
});

describe('XLSX streaming', () => {
  async function build(permissions = new Set()) {
    const res = mockResponse();
    await streamXlsx({
      res,
      columns,
      cursor: rows,
      filename: 'test',
      actor: { ...actor, permissions },
      reportName: 'Test report',
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.buffer());
    return { res, sheet: workbook.worksheets[0] };
  }

  it('produces a workbook a spreadsheet can actually open', async () => {
    // The assertion that would have caught the `views` bug: it throws during
    // the write, so there is no file to load at all.
    const { sheet } = await build();

    expect(sheet).toBeTruthy();
    expect(sheet.rowCount).toBe(3);
  });

  it('removes the restricted column from the header and every cell', async () => {
    const { sheet } = await build();

    const headers = sheet.getRow(1).values.filter(Boolean).map(String);
    expect(headers).toEqual(['Serial', 'Qty', 'Received']);

    let leaked = false;
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (String(cell.value ?? '').includes('9876543210')) leaked = true;
      });
    });
    expect(leaked).toBe(false);
  });

  it('includes it for an actor who holds the permission', async () => {
    const { sheet } = await build(new Set(['VIEW_CONTACT_DETAILS']));
    expect(sheet.getRow(1).values.filter(Boolean).map(String)).toContain('Phone');
  });

  it('preserves types instead of flattening everything to text', async () => {
    const { sheet } = await build();
    const row = sheet.getRow(2);

    // The reason this format exists: a CSV would hand Excel "123456789012345"
    // and Excel would store 1.23457E+14, corrupting it on the next save.
    expect(typeof row.getCell(1).value).toBe('string');
    expect(row.getCell(1).value).toBe('123456789012345');
    expect(typeof row.getCell(2).value).toBe('number');
    expect(row.getCell(3).value).toBeInstanceOf(Date);
  });

  it('freezes the header row', async () => {
    const { sheet } = await build();
    expect(sheet.views[0].state).toBe('frozen');
    expect(sheet.views[0].ySplit).toBe(1);
  });

  it('truncates a sheet name Excel would refuse to open', async () => {
    const res = mockResponse();
    await streamXlsx({
      res,
      columns,
      cursor: rows,
      filename: 't',
      actor,
      reportName: 'A report name far longer than Excel will tolerate on a tab',
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.buffer());
    expect(workbook.worksheets[0].name.length).toBeLessThanOrEqual(31);
  });
});
