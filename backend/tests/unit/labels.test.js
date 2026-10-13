import { generateQrSvg, generateBarcodeSvg, qrPayload, LABEL_MM } from '../../src/services/serial/labelService.js';

/**
 * BUSINESS RULE 19 — a QR code must expose nothing sensitive.
 *
 * The temptation is to encode product, warehouse and customer so a scan works
 * offline. A QR code is a public token: it is stuck to a box that travels
 * through couriers, loading bays and skips, and anyone with a phone can read
 * it. These tests exist so a future "helpful" change cannot quietly add the
 * customer name to a label.
 */
describe('QR payload', () => {
  const serial = {
    serialNumber: 'SRV0042',
    product: { name: 'Dell PowerEdge R760', sku: 'SRV-DELL-R760' },
    customer: { customerName: 'ACME Technologies' },
    warehouse: { code: 'WH-HYD' },
    status: 'DISPATCHED',
  };

  it('is the serial number and nothing else', async () => {
    expect(await qrPayload(serial)).toBe('SRV0042');
  });

  it('leaks no product, customer, warehouse or status', async () => {
    const payload = await qrPayload(serial);
    for (const secret of ['Dell', 'PowerEdge', 'ACME', 'WH-HYD', 'DISPATCHED', 'SRV-DELL-R760']) {
      expect(payload).not.toContain(secret);
    }
  });

  it('is not JSON or a URL — nothing to expand later', async () => {
    const payload = await qrPayload(serial);
    expect(payload).not.toMatch(/^[[{]/);
    expect(payload).not.toMatch(/https?:/);
  });
});

describe('label rendering', () => {
  it('produces a scannable QR SVG', async () => {
    const svg = await generateQrSvg('SRV0042');
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('viewBox');
  });

  it('produces a Code128 barcode with the serial printed beneath', async () => {
    const svg = await generateBarcodeSvg('SRV0042');
    expect(String(svg)).toMatch(/<svg/);
  });

  it('handles serials containing punctuation', async () => {
    // Manufacturers print what they like; the encoder must not be the reason a
    // real unit cannot be labelled.
    for (const serial of ['SN/2026-0042', 'ABC 123', 'X.Y_Z-1']) {
      await expect(generateQrSvg(serial)).resolves.toMatch(/^<svg/);
      await expect(generateBarcodeSvg(serial)).resolves.toBeTruthy();
    }
  });

  it('targets the agreed label size', () => {
    expect(LABEL_MM).toEqual({ width: 50, height: 25 });
  });
});
