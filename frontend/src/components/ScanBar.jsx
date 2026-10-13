import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScanLine, Loader2 } from 'lucide-react';
import api, { toMessage } from '../lib/apiClient.js';

/**
 * Global serial scan.
 *
 * A handheld scanner behaves like a keyboard that types fast and presses Enter,
 * so a plain input plus submit is all the integration needed — no driver, no
 * device API.
 *
 * Ctrl+K focuses it from anywhere, because someone holding a scanner and a box
 * should not have to find a text field with a mouse.
 */
export default function ScanBar() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    const serial = value.trim();
    if (!serial) return;

    setBusy(true);
    setError(null);
    try {
      const res = await api.get(`/serials/scan/${encodeURIComponent(serial)}`);
      setValue('');
      navigate(`/serials/${res.data.data.id}`);
    } catch (err) {
      setError(toMessage(err, 'Not found'));
      // Select rather than clear: a mis-scan is usually one wrong character,
      // and the next scan overwrites the selection anyway.
      inputRef.current?.select();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="relative hidden sm:block">
      <ScanLine className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => { setValue(e.target.value); setError(null); }}
        placeholder="Scan a serial number…"
        aria-label="Scan a serial number"
        className={`w-60 rounded border py-2 pl-8 pr-8 text-sm focus:outline-none ${
          error ? 'border-red-300 bg-red-50' : 'border-slate-300 focus:border-slate-500'
        }`}
      />
      {busy && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-slate-400" />}
      {error && <p className="absolute left-0 top-full mt-1 text-xs text-red-600">{error}</p>}
    </form>
  );
}
