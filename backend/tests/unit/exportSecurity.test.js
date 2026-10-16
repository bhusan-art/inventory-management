import { permittedColumns, csvCell, MAX_EXPORT_ROWS } from '../../src/services/reports/exportService.js';
import { REPORTS, REPORT_KEYS } from '../../src/services/reports/reportService.js';
import { RESTRICTED_FIELDS } from '../../src/constants/restrictedFields.js';
import { ALL_PERMISSION_CODES } from '../../src/constants/permissions.js';

const actorWith = (...permissions) => ({ permissions: new Set(permissions) });

describe('export column permissions', () => {
  it('drops a column whose permission the actor lacks', () => {
    const columns = [
      { key: 'name', header: 'Name' },
      { key: 'phone', header: 'Phone', model: 'Customer', field: 'phone' },
    ];

    const without = permittedColumns(columns, actorWith());
    expect(without.map((c) => c.key)).toEqual(['name']);

    const with_ = permittedColumns(columns, actorWith('VIEW_CONTACT_DETAILS'));
    expect(with_.map((c) => c.key)).toEqual(['name', 'phone']);
  });

  it('removes the column entirely rather than blanking it', () => {
    // A column of empty cells announces that the field exists and that the
    // reader is not trusted with it. Omit, do not mask (ARCHITECTURE.md §2.10).
    const columns = [{ key: 'phone', header: 'Phone', model: 'Customer', field: 'phone' }];
    const visible = permittedColumns(columns, actorWith());

    expect(visible).toHaveLength(0);
    expect(visible.some((c) => c.header === 'Phone')).toBe(false);
  });

  it('honours the registry without the column having to say so', () => {
    // The column declares only which model+field it reads. The registry — one
    // file, five consumers — decides the permission. A field restricted later
    // is therefore covered without anyone revisiting the export.
    expect(RESTRICTED_FIELDS.Vendor.bankDetails).toBeTruthy();

    const columns = [{ key: 'bankDetails', header: 'Bank', model: 'Vendor', field: 'bankDetails' }];
    expect(permittedColumns(columns, actorWith('VIEW_CONTACT_DETAILS'))).toHaveLength(0);
    expect(permittedColumns(columns, actorWith('VIEW_VENDOR_BANK_DETAILS'))).toHaveLength(1);
  });

  it('lets an explicit column permission override the registry', () => {
    const columns = [{ key: 'x', header: 'X', permission: 'VIEW_AUDIT_LOGS' }];
    expect(permittedColumns(columns, actorWith())).toHaveLength(0);
    expect(permittedColumns(columns, actorWith('VIEW_AUDIT_LOGS'))).toHaveLength(1);
  });
});

describe('every report is consistent with the registry', () => {
  it('guards each contact-detail column it exposes', () => {
    // The failure this prevents is the one the registry's own comment warns
    // about: "the API hides a field correctly for two years and then a new CSV
    // export quietly includes it."
    const noPermissions = actorWith();

    for (const key of REPORT_KEYS) {
      for (const column of REPORTS[key].columns) {
        const looksSensitive = /phone|email|bank/i.test(column.key);
        if (!looksSensitive) continue;

        const visible = permittedColumns([column], noPermissions);
        expect([key, column.key, visible.length]).toEqual([key, column.key, 0]);
      }
    }
  });

  it('names a real permission on every report', () => {
    const known = new Set(ALL_PERMISSION_CODES);
    for (const key of REPORT_KEYS) {
      expect([key, known.has(REPORTS[key].permission)]).toEqual([key, true]);
    }
  });

  it('declares at least one column per report and a unique key per column', () => {
    for (const key of REPORT_KEYS) {
      const keys = REPORTS[key].columns.map((c) => c.key);
      expect(keys.length).toBeGreaterThan(0);
      expect([key, new Set(keys).size]).toEqual([key, keys.length]);
    }
  });
});

describe('CSV cell escaping', () => {
  it('quotes and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('has,comma')).toBe('"has,comma"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('neutralises a formula so a spreadsheet does not execute it', () => {
    // A vendor name is attacker-controlled: whoever can type into our forms
    // chooses this string, and Excel runs it on the machine that opens the
    // export unless the leading character is defused.
    // Prefixed but not quoted: it contains no comma, double quote or newline,
    // so CSV syntax needs no quoting. The apostrophe is what defuses it.
    expect(csvCell('=cmd|\'/c calc\'!A1')).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell('+1234')).toBe("'+1234");
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
  });

  it('never prefixes a real number', () => {
    // The first version of this did, turning every negative quantity into the
    // text '-5. A number cannot be a formula; only strings are suspect.
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(1234.5)).toBe('1234.5');
    expect(csvCell(false)).toBe('false');
  });

  it('still protects a numeric-looking string, to keep phone numbers intact', () => {
    // "+919876543210" parses as a finite number. Exempting it would let Excel
    // evaluate the cell and drop the leading +, mangling the column.
    expect(csvCell('+919876543210')).toBe("'+919876543210");
    expect(csvCell('-5')).toBe("'-5");
  });

  it('renders null and undefined as empty, not as the word', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('')).toBe('');
  });

  it('writes dates in a sortable, unambiguous form', () => {
    expect(csvCell(new Date('2026-09-10T00:00:00Z'))).toBe('2026-09-10T00:00:00.000Z');
  });
});

describe('export limits', () => {
  it('caps rows at a figure that bounds memory and query time', () => {
    expect(MAX_EXPORT_ROWS).toBeGreaterThan(1000);
    expect(MAX_EXPORT_ROWS).toBeLessThanOrEqual(100_000);
  });
});
