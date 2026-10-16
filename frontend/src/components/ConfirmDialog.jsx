import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import api, { toMessage } from '../lib/apiClient.js';

/**
 * Confirmation for an action that cannot be undone from the interface.
 *
 * It performs the request itself rather than just answering yes/no, for one
 * reason: the failure belongs HERE. A dialog that closes on confirm and leaves
 * the caller to show the error means the user sees the record still present
 * with a message elsewhere on the page — or, worse, nothing at all. Keeping
 * the request inside means the dialog stays open, says why, and the record is
 * visibly still there.
 */
export default function ConfirmDialog({
  title, body, confirmLabel = 'Confirm', destructive = false,
  endpoint, method = 'delete', payload, reasonField, onClose, onDone,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const confirm = async () => {
    // Where the endpoint demands a reason, it demands a real one — the server
    // requires at least three characters, and a canned string typed by the
    // developer rather than the operator answers nobody's question later.
    if (reasonField && reason.trim().length < 3) {
      setError('Give a reason — this is recorded against the document.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await api[method](endpoint, reasonField ? { ...payload, reason: reason.trim() } : payload);
      onDone(res.data?.data);
    } catch (err) {
      // A 422 here is usually the domain refusing for a good reason — a
      // category still has products, a warehouse still holds stock. That
      // message is the useful part, so it is shown rather than replaced.
      setError(toMessage(err, 'Could not complete that'));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <div className="flex gap-3">
          {destructive && (
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-100">
              <AlertTriangle className="h-5 w-5 text-rose-700" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {body && <p className="mt-1 text-sm text-ink-soft">{body}</p>}
          </div>
        </div>

        {reasonField && (
          <label className="mt-4 block">
            <span className="mb-1 block text-xs font-medium text-ink-soft">
              {typeof reasonField === 'string' ? reasonField : 'Reason'}
              <span className="ml-0.5 text-rose-600">*</span>
            </span>
            <textarea
              rows={2} value={reason} maxLength={300}
              onChange={(e) => { setReason(e.target.value); setError(null); }}
              className="w-full rounded-control border border-line-strong px-3 py-2 text-sm"
            />
          </label>
        )}

        {error && (
          <p className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-800">{error}</p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button" onClick={onClose} disabled={busy}
            className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button" onClick={confirm} disabled={busy}
            className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm text-white disabled:opacity-60 ${
              destructive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-slate-900 hover:bg-slate-700'
            }`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
