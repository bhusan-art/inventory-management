import asyncHandler from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import * as reportService from '../services/reports/reportService.js';
import * as exportService from '../services/reports/exportService.js';

export const listReports = asyncHandler(async (req, res) => {
  return ok(res, { data: reportService.availableReports(req.actor) });
});

/**
 * Runs a report for on-screen display.
 *
 * The columns are filtered the same way the export filters them, by the same
 * function — so what a person sees and what they can download cannot diverge.
 */
export const runReport = asyncHandler(async (req, res) => {
  const report = reportService.getReport(req.actor, req.params.key);
  const rows = await report.rows(req.actor, req.query);
  const columns = exportService.permittedColumns(report.columns, req.actor);
  const visible = new Set(columns.map((c) => c.key));

  return ok(res, {
    data: {
      name: report.name,
      columns: columns.map((c) => ({ key: c.key, header: c.header, type: c.type ?? 'string' })),
      // Rows are projected down to the permitted columns too. Sending the full
      // row and letting the client show a subset would put a restricted value
      // in a payload the browser can read.
      rows: rows.slice(0, 1000).map((row) => {
        const out = {};
        for (const key of visible) out[key] = row[key] ?? null;
        return out;
      }),
    },
    meta: {
      total: rows.length,
      returned: Math.min(rows.length, 1000),
      truncated: rows.length > 1000,
      withheldColumns: report.columns.length - columns.length,
    },
  });
});

export const exportReport = asyncHandler(async (req, res) => {
  const report = reportService.getReport(req.actor, req.params.key);
  const format = exportService.assertFormat(String(req.query.format ?? 'csv').toLowerCase());

  const rows = await report.rows(req.actor, req.query);
  const filename = `${req.params.key}-${new Date().toISOString().slice(0, 10)}`;

  const options = {
    res,
    columns: report.columns,
    cursor: rows,
    filename,
    actor: req.actor,
    reportName: report.name,
  };

  return format === 'xlsx'
    ? exportService.streamXlsx(options)
    : exportService.streamCsv(options);
});
