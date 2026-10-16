import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';
import api, { fieldErrors, toMessage } from '../../lib/apiClient.js';
import { FIELD_COMPONENTS } from './fields.jsx';

/**
 * One form for every entity, driven by the field descriptors in the config.
 *
 * The alternative is eight hand-written forms that each drift from the Zod
 * schema they post to, in eight different directions. Here a field exists once
 * and the submit path is identical everywhere, so a fix to error handling or
 * focus management is a fix everywhere.
 *
 * `fieldErrors()` in the API client has existed since Phase 1 and had no
 * caller. It maps the server's `body.productCode` to `productCode`, which is
 * what attaches a validation message to the input that caused it rather than
 * dumping "Validation failed" at the top and leaving the user to hunt.
 */

/**
 * The empty value for a field type.
 *
 * This exists because `function Field({ value = [] })` does NOT catch `null` —
 * a default parameter only fires for `undefined`. Initialising every untouched
 * field to `null` therefore handed the array fields a null and they crashed on
 * `.length` the instant the form opened. It built clean and linted clean; only
 * opening it in a browser showed it.
 */
function emptyFor(field) {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case 'keyvalue':
    case 'racks': return [];
    case 'address': return {};
    case 'checkbox': return false;
    default: return null;
  }
}

function initialValues(fields, record) {
  const values = {};
  for (const field of fields) {
    if (record) {
      // An edit loads the serialized record, where a reference is an object
      // ({ id, name }) but the API expects an id back. Sending the object
      // would fail validation on a field the user never touched.
      const current = record[field.name];
      values[field.name] = field.type === 'reference'
        ? (current?.id ?? current ?? null)
        : current ?? emptyFor(field);
    } else {
      values[field.name] = emptyFor(field);
    }
  }
  return values;
}

/** Drops what the API would reject or store as noise. */
function toPayload(fields, values) {
  const body = {};

  for (const field of fields) {
    let value = values[field.name];

    if (field.type === 'keyvalue') {
      value = (value ?? []).filter((r) => r.key?.trim());
    } else if (field.type === 'racks') {
      value = (value ?? []).filter((r) => r.code?.trim());
    } else if (field.type === 'address') {
      // An address object of empty strings is not an address. Sending one
      // writes a record that looks populated on every screen that renders it.
      const parts = Object.entries(value ?? {}).filter(([, v]) => v !== '' && v != null);
      value = parts.length > 0 ? Object.fromEntries(parts) : undefined;
    } else if (typeof value === 'string') {
      value = value.trim() === '' ? undefined : value.trim();
    }

    if (value === null && !field.nullable) continue;
    if (value === undefined) continue;
    body[field.name] = value;
  }

  return body;
}

export default function EntityForm({
  fields, record, endpoint, title, onClose, onSaved,
}) {
  const [values, setValues] = useState(() => initialValues(fields, record));
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const firstInput = useRef(null);

  // Focus the first field. A modal that opens with focus still on the page
  // behind it makes keyboard use feel broken.
  useEffect(() => {
    const id = setTimeout(() => firstInput.current?.querySelector('input, select, textarea')?.focus(), 50);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const set = (name, value) => {
    setValues((v) => ({ ...v, [name]: value }));
    // Clear the error as soon as the field is touched. Leaving a stale message
    // under a field the user has just corrected reads as "still wrong".
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };

  const visible = fields.filter((f) => !f.when || f.when(values));

  const submit = async (event) => {
    event.preventDefault();
    setMessage(null);

    const missing = {};
    for (const field of visible) {
      const value = values[field.name];
      if (field.required && (value === null || value === undefined || value === '')) {
        missing[field.name] = 'Required';
      }
    }
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      setMessage('Fill in the highlighted fields.');
      return;
    }

    setSaving(true);
    try {
      const body = toPayload(visible, values);
      const saved = record
        ? await api.put(`/${endpoint}/${record.id}`, body)
        : await api.post(`/${endpoint}`, body);
      onSaved(saved.data.data);
    } catch (err) {
      const byField = fieldErrors(err);
      setErrors(byField);
      setMessage(
        Object.keys(byField).length > 0
          ? 'The server rejected some values.'
          : toMessage(err, 'Could not save'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
      <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="rounded-md p-1 text-ink-muted hover:bg-paper hover:text-ink-soft"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={submit} noValidate>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4" ref={firstInput}>
            {message && (
              <div className="flex items-start gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {message}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {visible.map((field) => {
                const Component = FIELD_COMPONENTS[field.type];
                if (!Component) return null;
                const full = field.full || ['address', 'keyvalue', 'racks', 'textarea'].includes(field.type);

                return (
                  <div key={field.name} className={full ? 'sm:col-span-2' : ''}>
                    <Component
                      field={field}
                      value={values[field.name]}
                      error={errors[field.name]}
                      errors={errors}
                      onChange={(v) => set(field.name, v)}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            <button
              type="button" onClick={onClose} disabled={saving}
              className="rounded-control border border-line-strong px-3 py-2 text-sm text-ink-soft hover:bg-paper disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={saving}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {record ? 'Save changes' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
