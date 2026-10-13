import QRCode from 'qrcode';
import bwipjs from 'bwip-js';
import { SerialNumber } from '../../models/SerialNumber.js';
import { NotFoundError } from '../../utils/errors.js';

/**
 * Labels for serialized units.
 *
 * BUSINESS RULE 19: a QR code must expose nothing sensitive. The payload here
 * is the serial number and nothing else.
 *
 * The temptation is to encode product name, warehouse and customer so a scan
 * works offline. Do not: a QR code is a public token — it is stuck to a box
 * that travels through couriers, customer loading bays and skips, and anyone
 * with a phone can read it. Encoding the customer name tells a competitor who
 * your customers are from a photograph of a pallet.
 *
 * The serial alone is meaningless to an outsider and sufficient for us: the
 * scan endpoint resolves it, with authentication and permissions applied.
 */
const LABEL_MM = { width: 50, height: 25 };

export async function qrPayload(serial) {
  // Deliberately not JSON, not a URL with query parameters. Just the serial.
  return serial.serialNumber;
}

export async function generateQrSvg(serialNumber, { width = 220 } = {}) {
  return QRCode.toString(serialNumber, { type: 'svg', margin: 1, width, errorCorrectionLevel: 'M' });
}

export async function generateBarcodeSvg(serialNumber, { height = 12 } = {}) {
  return bwipjs.toSVG({
    bcid: 'code128',
    text: serialNumber,
    height,
    includetext: true,
    textxalign: 'center',
    textsize: 8,
  });
}

export async function getLabelData(actor, id) {
  const serial = await SerialNumber.findOne({ _id: id, tenantId: actor.tenantId })
    .populate('product', 'name sku')
    .populate('warehouse', 'code');
  if (!serial) throw new NotFoundError('Serial number not found');
  return serial;
}

/**
 * A printable label sheet.
 *
 * Returned as HTML with print CSS rather than a PDF: label printers and office
 * printers both handle a browser print dialogue, the page size is set in
 * millimetres so it matches the stock, and there is no PDF toolchain to carry.
 */
export async function renderLabelSheet(serials, { copies = 1 } = {}) {
  const labels = [];

  for (const serial of serials) {
    const [qr, barcode] = await Promise.all([
      generateQrSvg(serial.serialNumber, { width: 120 }),
      generateBarcodeSvg(serial.serialNumber, { height: 8 }),
    ]);

    for (let i = 0; i < copies; i += 1) {
      labels.push(`
      <div class="label">
        <div class="qr">${qr}</div>
        <div class="detail">
          <div class="sku">${escapeHtml(serial.product?.sku ?? '')}</div>
          <div class="name">${escapeHtml(truncate(serial.product?.name ?? '', 28))}</div>
          <div class="barcode">${barcode}</div>
        </div>
      </div>`);
    }
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Labels</title>
<style>
  @page { size: ${LABEL_MM.width}mm ${LABEL_MM.height}mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; }
  .label {
    width: ${LABEL_MM.width}mm; height: ${LABEL_MM.height}mm;
    display: flex; align-items: center; gap: 1.5mm; padding: 1.5mm;
    page-break-after: always; overflow: hidden;
  }
  .qr { width: 20mm; height: 20mm; flex: none; }
  .qr svg { width: 100%; height: 100%; }
  .detail { flex: 1; min-width: 0; }
  .sku { font-size: 7pt; font-weight: bold; }
  .name { font-size: 5.5pt; color: #333; margin-bottom: 0.5mm; }
  .barcode svg { width: 100%; height: 9mm; }
  @media screen {
    body { background: #f1f5f9; padding: 10mm; }
    .label { background: #fff; border: 1px solid #cbd5e1; margin-bottom: 4mm; }
  }
</style></head>
<body>${labels.join('')}</body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export { LABEL_MM };
