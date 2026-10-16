import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, ShieldCheck, ShieldOff } from 'lucide-react';
import api, { toMessage } from '../../lib/apiClient.js';

/**
 * Raising a ticket.
 *
 * The serial number does the work: it identifies the customer, the product and
 * the live cover, so a support desk types one thing. The optional lookup below
 * is a courtesy — it tells the person whether the unit is covered BEFORE they
 * commit, which is the question the customer is asking on the phone.
 */
export default function NewServiceRequestPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ serialNumber: '', issueDescription: '', priority: 'MEDIUM' });
  const [lookup, setLookup] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const check = async () => {
    const serial = form.serialNumber.trim().toUpperCase();
    if (!serial) return;
    setLookup({ loading: true });
    try {
      const res = await api.get(`/serials/scan/${encodeURIComponent(serial)}`);
      setLookup({ unit: res.data.data });
    } catch (err) {
      setLookup({ error: toMessage(err, 'That serial number was not found') });
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/service-requests', {
        serialNumber: form.serialNumber.trim().toUpperCase() || undefined,
        issueDescription: form.issueDescription,
        priority: form.priority,
      });
      navigate(`/service-requests/${res.data.data.id}`);
    } catch (err) {
      setError(toMessage(err, 'Could not raise the ticket'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <Link to="/service-requests" className="mb-1 flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> All service requests
        </Link>
        <h1 className="text-lg font-semibold text-ink">Raise a service request</h1>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <form onSubmit={submit} className="space-y-4 rounded-panel border border-line bg-surface p-4">
        <div>
          <label htmlFor="serial" className="block text-sm text-ink-soft">Serial number</label>
          <div className="mt-1 flex gap-2">
            <input
              id="serial"
              value={form.serialNumber}
              onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value.toUpperCase() }))}
              onBlur={check}
              placeholder="SN-000123"
              className="w-64 rounded-control border border-line-strong px-2 py-1.5 font-mono text-sm focus:border-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={check}
              className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:bg-paper"
            >
              Check cover
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            The customer, product and warranty are taken from the unit itself.
          </p>
        </div>

        {lookup?.unit && <CoverNote unit={lookup.unit} />}
        {lookup?.error && <p className="text-sm text-red-700">{lookup.error}</p>}

        <div>
          <label htmlFor="issue" className="block text-sm text-ink-soft">What is wrong</label>
          <textarea
            id="issue"
            value={form.issueDescription}
            onChange={set('issueDescription')}
            rows={4}
            minLength={10}
            required
            placeholder="What the customer reported, in their words where possible"
            className="mt-1 w-full rounded-control border border-line-strong px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="priority" className="block text-sm text-ink-soft">Priority</label>
          <select
            id="priority"
            value={form.priority}
            onChange={set('priority')}
            className="mt-1 rounded-control border border-line-strong px-2 py-1.5 text-sm"
          >
            <option value="LOW">Low — 7 days</option>
            <option value="MEDIUM">Medium — 3 days</option>
            <option value="HIGH">High — 24 hours</option>
            <option value="CRITICAL">Critical — 4 hours</option>
          </select>
          {/* The clock starts now and is never reset by a later change, so the
              choice matters more than it looks. */}
          <p className="mt-1 text-xs text-ink-muted">
            Sets the response deadline, measured from when the fault was reported.
          </p>
        </div>

        <button
          type="submit"
          disabled={busy || form.issueDescription.trim().length < 10}
          className="rounded bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {busy ? 'Raising…' : 'Raise ticket'}
        </button>
      </form>
    </div>
  );
}

function CoverNote({ unit }) {
  const warranty = unit.currentWarranty ?? unit.warranty ?? null;
  const covered = warranty && ['ACTIVE', 'EXPIRING_SOON'].includes(warranty.status);

  return (
    <div className="rounded border border-line bg-paper p-3 text-sm">
      <p className="text-ink">
        {unit.product?.name ?? 'Unknown product'}
        {unit.customer?.name ? ` · ${unit.customer.name}` : ' · not issued to a customer'}
      </p>
      <p className="mt-1 flex items-center gap-1 text-xs">
        {covered ? (
          <>
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            <span className="text-emerald-700">
              In warranty until {formatDate(warranty.endDate)} — the repair is covered.
            </span>
          </>
        ) : (
          <>
            <ShieldOff className="h-3.5 w-3.5 text-ink-muted" />
            <span className="text-ink-soft">
              {warranty
                ? `Cover ended ${formatDate(warranty.endDate)} — this repair is chargeable.`
                : 'No warranty on record — this repair is chargeable.'}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
