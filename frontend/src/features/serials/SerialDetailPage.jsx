import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, QrCode, Printer, Package, Warehouse as WarehouseIcon,
  User as UserIcon, Clock, AlertCircle,
} from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';
import { usePermission } from '../../hooks/usePermission.js';
import { StatusBadge } from '../../components/table/DataTable.jsx';

/**
 * The per-unit page — the answer to "what has happened to this thing".
 *
 * Its reason to exist is the timeline: purchase, receipt, movements, repairs,
 * dispatch, all in one place. That traceability is the point of the whole
 * system, and this is where a person actually sees it.
 */
export default function SerialDetailPage() {
  const { id } = useParams();
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [showQr, setShowQr] = useState(false);
  const [printing, setPrinting] = useState(false);
  const canOverride = usePermission('OVERRIDE_SERIAL_STATUS');

  const openLabel = async () => {
    setPrinting(true);
    try {
      const res = await api.get(`/serials/${id}/label`, { responseType: 'text' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/html' }));
      window.open(url, '_blank', 'noopener');
      // Freed once the new tab has had time to load it; revoking immediately
      // races the browser and yields a blank tab.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setState((s) => ({ ...s, error: toMessage(err, 'Could not produce the label') }));
    } finally {
      setPrinting(false);
    }
  };

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const res = await api.get(`/serials/${id}/history`);
      setState({ data: res.data.data, loading: false, error: null });
    } catch (err) {
      setState({ data: null, loading: false, error: toMessage(err, 'Could not load this unit') });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (state.loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (state.error) {
    return (
      <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        {state.error}
      </div>
    );
  }

  const { serial, events, movements } = state.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/serials" className="mb-1 flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
            <ArrowLeft className="h-3.5 w-3.5" /> All serial numbers
          </Link>
          <h1 className="font-mono text-lg font-semibold text-slate-900">{serial.serialNumber}</h1>
          <p className="text-sm text-slate-500">{serial.product?.name}</p>
        </div>

        <div className="flex items-center gap-2">
          <StatusBadge value={serial.status} />
          <button
            onClick={() => setShowQr((v) => !v)}
            className="flex items-center gap-1.5 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
          >
            <QrCode className="h-4 w-4" /> QR
          </button>
          {/*
            Fetched through the API client, not opened as a plain link.
            The access token lives in memory and travels in the Authorization
            header; a new tab carries neither, so a direct href would 401. The
            HTML is fetched authenticated, turned into a blob URL, and opened —
            where the browser's own print dialogue handles the label stock.
          */}
          <button
            onClick={openLabel}
            disabled={printing}
            className="flex items-center gap-1.5 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          >
            <Printer className="h-4 w-4" /> {printing ? 'Preparing…' : 'Label'}
          </button>
        </div>
      </div>

      {showQr && <QrPanel serialId={serial.id} serialNumber={serial.serialNumber} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact icon={Package} label="Product" value={serial.product?.name} sub={serial.product?.code} />
        <Fact icon={WarehouseIcon} label="Location" value={serial.warehouse?.name ?? 'Not in a warehouse'} sub={serial.rackLocation} />
        <Fact icon={UserIcon} label="Customer" value={serial.customer?.name ?? 'Not issued'} sub={serial.installationLocation} />
        <Fact icon={Clock} label="Received" value={formatDate(serial.receivedDate)} sub={serial.vendor?.name} />
      </div>

      {(serial.assetTag || serial.macAddress || serial.imei) && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-medium text-slate-900">Identifiers</h2>
          <dl className="grid gap-3 sm:grid-cols-3">
            {[['Asset tag', serial.assetTag], ['MAC address', serial.macAddress], ['IMEI', serial.imei]]
              .filter(([, v]) => v)
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="font-mono text-sm text-slate-900">{value}</dd>
                </div>
              ))}
          </dl>
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-medium text-slate-900">Lifecycle</h2>
          <p className="text-xs text-slate-500">
            {events.length} event{events.length === 1 ? '' : 's'}
            {movements.length > 0 && ` · ${movements.length} stock movement${movements.length === 1 ? '' : 's'}`}
          </p>
        </div>

        <ol className="divide-y divide-slate-100">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3 px-4 py-3">
              <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-900">
                  {event.fromStatus ? `${humanize(event.fromStatus)} → ` : ''}
                  <span className="font-medium">{humanize(event.toStatus)}</span>
                </p>
                <p className="text-xs text-slate-500">
                  {humanize(event.eventType)}
                  {event.reference?.number && ` · ${event.reference.number}`}
                  {event.warehouse?.name && ` · ${event.warehouse.name}`}
                </p>
                {event.remarks && <p className="mt-1 text-xs text-slate-600">{event.remarks}</p>}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</p>
                {event.performedBy?.name && <p className="text-xs text-slate-400">{event.performedBy.name}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {canOverride && (
        <p className="text-xs text-slate-500">
          Status corrections are made through the API; every override moves the quantity with it
          and is recorded in the audit log.
        </p>
      )}
    </div>
  );
}

function QrPanel({ serialId, serialNumber }) {
  const [svg, setSvg] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get(`/serials/${serialId}/qrcode`, { responseType: 'text' })
      .then((res) => !cancelled && setSvg(res.data))
      .catch(() => !cancelled && setSvg(null));
    return () => { cancelled = true; };
  }, [serialId]);

  return (
    <div className="flex items-center gap-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="h-28 w-28">
        {/* The SVG comes from our own authenticated API, generated by the
            qrcode library from a serial number — not from user input. */}
        {svg
          ? <div dangerouslySetInnerHTML={{ __html: svg }} />
          : <div className="h-full w-full animate-pulse rounded bg-slate-100" />}
      </div>
      <div>
        <p className="font-mono text-sm text-slate-900">{serialNumber}</p>
        {/* Says out loud what the code contains, so nobody assumes it holds
            more and builds an offline reader expecting product data. */}
        <p className="mt-1 max-w-sm text-xs text-slate-500">
          The code contains only the serial number. Scanning it looks the unit up through the
          API, so nothing about the product, customer or location is readable from the label
          itself.
        </p>
      </div>
    </div>
  );
}

function Fact({ icon: Icon, label, value, sub }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <p className="mt-1 truncate text-sm font-medium text-slate-900">{value ?? '—'}</p>
      {sub && <p className="truncate text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

const humanize = (v) => (v ? String(v).replace(/_/g, ' ').toLowerCase() : '—');

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}
