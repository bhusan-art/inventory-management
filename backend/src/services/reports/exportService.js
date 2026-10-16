import ExcelJS from 'exceljs';
import { restrictedFieldsFor } from '../../constants/restrictedFields.js';
import { writeAudit } from '../shared/auditService.js';
import { DomainError } from '../../utils/errors.js';
import logger from '../../config/logger.js';

/**
 * The export builder — the fifth consumer named in the restricted-field
 * registry, and the one its comment warned about:
 *
 *   "the API hides a field correctly for two years and then a new CSV export
 *    quietly includes it."
 *
 * An export is the easiest place in any system to leak, because it is written
 * once, against raw rows, by someone thinking about columns rather than
 * permissions. So the rule here is not "remember to filter" — it is that a
 * column declares the permission it needs, and a column whose permission the
 * actor lacks is REMOVED FROM THE HEADER as well as the data.
 *
 * Removing it from the header matters. A column of blanks tells the reader the
 * field exists and that they are not allowed to see it, which is a small
 * disclosure and an invitation. An absent column says nothing at all —
 * consistent with §2.10, omit rather than mask.
 */

/** Maximum rows in one export. Beyond this, the caller must narrow the filter. */
export const MAX_EXPORT_ROWS = 50_000;

/**
 * Resolves the columns this actor may see.
 *
 * @param {Array<{key,header,permission?,model?,field?,type?,width?}>} columns
 */
export function permittedColumns(columns, actor) {
  return columns.filter((column) => {
    // An explicit permission on the column wins.
    if (column.permission) return actor.permissions.has(column.permission);

    // Otherwise, if the column maps to a registry-restricted field, the
    // registry decides — so a column added later to an already-restricted
    // field is covered without anyone remembering to annotate it.
    if (column.model && column.field) {
      const required = restrictedFieldsFor(column.model)[column.field];
      if (required) return actor.permissions.has(required);
    }

    return true;
  });
}

const CSV_INJECTION_PREFIX = /^[=+\-@\t\r]/;

/**
 * Escapes one CSV cell.
 *
 * Two separate problems:
 *
 * 1. CSV syntax — quotes, commas and newlines inside a value must be quoted
 *    and the quotes doubled, or the file simply parses wrong.
 *
 * 2. FORMULA INJECTION — a value starting with =, +, -, @ or a control
 *    character is executed as a formula when the file is opened in Excel or
 *    Sheets. A vendor named `=cmd|'/c calc'!A1` becomes code running on the
 *    machine of whoever opens the export. The data is ours and came from our
 *    own forms, which is exactly the assumption that makes this work: the
 *    attacker is whoever could type into any text field we have.
 *
 *    Prefixing with a single quote neutralises it; Excel shows the original
 *    text and evaluates nothing.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';

  // A real number cannot be a formula, and prefixing it would corrupt the
  // data: a quantity change of -5 would export as the text '-5 and stop being
  // a number. Only strings are suspect.
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  let text = value instanceof Date ? value.toISOString() : String(value);

  // Numeric-LOOKING strings are still prefixed, deliberately. "+919876543210"
  // parses as a finite number, so exempting it would let Excel evaluate the
  // cell and drop the leading +, silently mangling every phone number in the
  // file. A visible apostrophe is a far smaller cost than a corrupted column.
  if (CSV_INJECTION_PREFIX.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Streams a CSV straight to the response.
 *
 * Rows are written as they arrive from a cursor rather than collected into an
 * array first: a 50,000-row export built in memory is both a latency spike and
 * a way for one request to exhaust the heap.
 */
export async function streamCsv({ res, columns, cursor, filename, actor, reportName }) {
  const visible = permittedColumns(columns, actor);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}.csv"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  // A BOM, so Excel on Windows reads UTF-8 rather than guessing the system
  // code page and mangling any non-ASCII name.
  res.write('﻿');
  res.write(`${visible.map((c) => csvCell(c.header)).join(',')}\n`);

  let rows = 0;
  try {
    for await (const row of cursor) {
      if (rows >= MAX_EXPORT_ROWS) break;
      res.write(`${visible.map((c) => csvCell(valueOf(row, c))).join(',')}\n`);
      rows += 1;
    }
  } catch (err) {
    return failMidStream(res, err, reportName);
  }

  res.end();
  await recordExport({ actor, reportName, format: 'CSV', rows, columns: visible });
  return rows;
}

/**
 * Streams an XLSX.
 *
 * Worth the dependency over CSV alone for one concrete reason: types survive.
 * A serial number like `123456789012345` is a string here; in a CSV, Excel
 * decides it is a number and shows `1.23457E+14`, permanently corrupting it on
 * the next save. Dates arrive as dates rather than text that sorts
 * alphabetically. For a file whose whole purpose is to be opened in Excel,
 * that is not a nicety.
 */
export async function streamXlsx({ res, columns, cursor, filename, actor, reportName }) {
  const visible = permittedColumns(columns, actor);

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}.xlsx"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  // The streaming writer flushes each row to the response instead of holding
  // the whole workbook in memory.
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  // The frozen pane is passed as an OPTION, not assigned afterwards.
  // `WorksheetWriter.views` is a getter with no setter, so `sheet.views = [...]`
  // throws — and it throws after the response headers have gone out, so Express
  // cannot turn it into a 500. The client just sees the connection abort, which
  // is a singularly unhelpful way to learn about a typo.
  //
  // The sheet name is capped at 31 characters because Excel refuses to open a
  // workbook with a longer one.
  const sheet = workbook.addWorksheet(reportName.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = visible.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? Math.max(12, c.header.length + 2),
  }));
  sheet.getRow(1).font = { bold: true };

  let rows = 0;
  try {
    for await (const row of cursor) {
      if (rows >= MAX_EXPORT_ROWS) break;

      const record = {};
      for (const column of visible) record[column.key] = coerce(valueOf(row, column), column.type);
      sheet.addRow(record).commit();
      rows += 1;
    }

    sheet.commit();
    await workbook.commit();
  } catch (err) {
    return failMidStream(res, err, reportName);
  }

  await recordExport({ actor, reportName, format: 'XLSX', rows, columns: visible });
  return rows;
}

/** Reads a column's value out of a row, via `value(row)` or a dotted path. */
function valueOf(row, column) {
  if (typeof column.value === 'function') return column.value(row);

  return column.key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), row);
}

/** Keeps a value as the type Excel should store it as. */
function coerce(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'number') return Number(value);
  if (type === 'date') return value instanceof Date ? value : new Date(value);
  // Default to text. A serial number is an identifier, not a quantity.
  return value instanceof Date ? value : String(value);
}

/**
 * Something threw after the headers went out.
 *
 * Express cannot turn this into a 500 — the status line is already on the
 * wire — so the client sees the connection abort and learns nothing. That is
 * how a one-line mistake in this file (`sheet.views = [...]`, which throws on a
 * streaming worksheet) presented as a bare "aborted" with no stack anywhere the
 * caller could see.
 *
 * The response cannot be rescued, but the SERVER can at least record why, and
 * destroying the socket rather than ending it cleanly means the client gets a
 * truncated transfer instead of a file that looks complete and is not.
 */
function failMidStream(res, err, reportName) {
  logger.error({ err, reportName }, 'Export failed after the response had started');
  res.destroy(err);
  return 0;
}

function safeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
}

/**
 * Every export is audited.
 *
 * An export is a bulk read — the single largest disclosure the system permits
 * in one request — so who took what, and which columns they were entitled to,
 * is worth recording. The column list in particular: it is the evidence that
 * the restricted ones were withheld.
 */
async function recordExport({ actor, reportName, format, rows, columns }) {
  await writeAudit({
    action: 'DATA_EXPORTED',
    module: 'Report',
    recordLabel: reportName,
    severity: 'NOTICE',
    tenantId: actor.tenantId,
    metadata: {
      format,
      rows,
      columns: columns.map((c) => c.key),
    },
  });
}

export function assertFormat(format) {
  if (!['csv', 'xlsx'].includes(format)) {
    throw new DomainError(`Unsupported export format: ${format}`, 'UNSUPPORTED_FORMAT');
  }
  return format;
}
