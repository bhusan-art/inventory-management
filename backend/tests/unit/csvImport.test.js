import { parseCsv } from '../../src/services/master/productImport.js';
import { maskBankDetails } from '../../src/serializers/master.serializer.js';
import { escapeRegex } from '../../src/services/shared/crudFactory.js';

describe('parseCsv', () => {
  it('reads a simple file into keyed rows', () => {
    const rows = parseCsv('name,sku\nServer,SRV-1\nSwitch,SW-1\n');
    expect(rows).toEqual([
      { name: 'Server', sku: 'SRV-1' },
      { name: 'Switch', sku: 'SW-1' },
    ]);
  });

  it('handles quoted fields containing commas', () => {
    const rows = parseCsv('name,description\n"Cable, 24F","Single mode, armoured"\n');
    expect(rows[0]).toEqual({ name: 'Cable, 24F', description: 'Single mode, armoured' });
  });

  it('handles escaped quotes', () => {
    const rows = parseCsv('name\n"3"" patch panel"\n');
    expect(rows[0].name).toBe('3" patch panel');
  });

  it('handles newlines inside quoted fields', () => {
    const rows = parseCsv('name,description\nSwitch,"Line one\nLine two"\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Line one\nLine two');
  });

  it('strips a UTF-8 BOM — Excel adds one on every export', () => {
    const rows = parseCsv('\uFEFFname,sku\nServer,SRV-1\n');
    expect(Object.keys(rows[0])).toEqual(['name', 'sku']);
  });

  it('normalizes Windows line endings', () => {
    const rows = parseCsv('name,sku\r\nServer,SRV-1\r\n');
    expect(rows).toEqual([{ name: 'Server', sku: 'SRV-1' }]);
  });

  it('returns nothing for a header-only or empty file', () => {
    expect(parseCsv('name,sku\n')).toEqual([]);
    expect(parseCsv('')).toEqual([]);
  });

  it('ignores blank lines', () => {
    expect(parseCsv('name\nServer\n\n\nSwitch\n')).toHaveLength(2);
  });
});

describe('maskBankDetails', () => {
  it('shows only the last four digits', () => {
    const masked = maskBankDetails({
      accountName: 'Dell India', accountNumber: '123456789012', ifsc: 'HDFC0001234', bankName: 'HDFC',
    });
    expect(masked.accountNumberMasked).toBe('••••9012');
    expect(JSON.stringify(masked)).not.toContain('123456789012');
  });

  it('keeps the fields needed to identify the account', () => {
    const masked = maskBankDetails({ accountNumber: '999900001111', ifsc: 'ICIC0000123', bankName: 'ICICI' });
    expect(masked.ifsc).toBe('ICIC0000123');
    expect(masked.bankName).toBe('ICICI');
  });

  it('handles a missing record', () => {
    expect(maskBankDetails(null)).toBeNull();
  });
});

describe('escapeRegex', () => {
  it('neutralizes regex metacharacters in user search text', () => {
    // Without this, a search for ".*" scans the whole collection and a search
    // for "(" throws a driver error the user cannot interpret.
    expect(escapeRegex('.*')).toBe('\\.\\*');
    expect(escapeRegex('a+b(c)')).toBe('a\\+b\\(c\\)');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeRegex('Dell R760')).toBe('Dell R760');
  });
});
