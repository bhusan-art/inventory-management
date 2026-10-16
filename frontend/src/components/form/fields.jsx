import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import api from '../../lib/apiClient.js';

/**
 * Form field primitives.
 *
 * Every field takes the same shape — `{ field, value, error, onChange }` — so
 * `EntityForm` can render a list of descriptors without knowing what any of
 * them are. Adding a field type here is the only change needed to support it
 * everywhere.
 *
 * Errors are passed IN rather than derived. The server is the authority on
 * what is valid: it holds the Zod schemas, and a second copy of those rules in
 * the browser would disagree with it eventually — always in the direction of
 * accepting something the API then rejects. Client-side checks here are
 * limited to `required`, which is about not wasting a round trip rather than
 * about correctness.
 */

const baseInput =
  'w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-900/10';

const borderFor = (error) => (error ? 'border-rose-400 bg-rose-50/40' : 'border-line-strong');

export function Label({ field, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">
        {field.label}
        {field.required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      {children}
      {field.help && <span className="mt-1 block text-xs text-ink-muted">{field.help}</span>}
    </label>
  );
}

function Error({ error }) {
  if (!error) return null;
  return <span className="mt-1 block text-xs text-rose-700">{error}</span>;
}

export function TextField({ field, value, error, onChange }) {
  return (
    <div>
      <Label field={field}>
        <input
          type={field.inputType ?? 'text'}
          value={value ?? ''}
          maxLength={field.max}
          placeholder={field.placeholder}
          // `code` fields are uppercase on the server (`.toUpperCase()` in the
          // schema). Showing them uppercase as they are typed means the value
          // the user sees is the value that gets stored.
          onChange={(e) => onChange(field.uppercase ? e.target.value.toUpperCase() : e.target.value)}
          className={`${baseInput} ${borderFor(error)} ${field.mono ? 'font-mono' : ''}`}
        />
      </Label>
      <Error error={error} />
    </div>
  );
}

export function TextAreaField({ field, value, error, onChange }) {
  return (
    <div>
      <Label field={field}>
        <textarea
          rows={field.rows ?? 3}
          value={value ?? ''}
          maxLength={field.max}
          onChange={(e) => onChange(e.target.value)}
          className={`${baseInput} ${borderFor(error)}`}
        />
      </Label>
      <Error error={error} />
    </div>
  );
}

export function NumberField({ field, value, error, onChange }) {
  return (
    <div>
      <Label field={field}>
        <input
          type="number"
          value={value ?? ''}
          min={field.min ?? 0}
          max={field.max}
          // An empty box is null, not 0. Sending 0 for "I did not set a
          // reorder level" turns a blank into a deliberate-looking figure that
          // the low-stock report would then act on.
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          className={`${baseInput} ${borderFor(error)}`}
        />
      </Label>
      <Error error={error} />
    </div>
  );
}

export function SelectField({ field, value, error, onChange }) {
  return (
    <div>
      <Label field={field}>
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          className={`${baseInput} ${borderFor(error)} bg-white`}
        >
          {!field.required && <option value="">—</option>}
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Label>
      <Error error={error} />
    </div>
  );
}

export function CheckboxField({ field, value, onChange }) {
  return (
    <label className="flex items-center gap-2 py-1.5">
      <input
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-line-strong"
      />
      <span className="text-sm text-ink-soft">{field.label}</span>
    </label>
  );
}

/**
 * A dropdown of another collection — a product's category, a PO's vendor.
 *
 * Loads once on mount and keeps the rows. These lists are small and change
 * rarely, and re-fetching on every keystroke of an unrelated field would make
 * the form feel slower than the data justifies.
 *
 * A reference that fails to load renders as a DISABLED select saying so,
 * rather than an empty dropdown. An empty dropdown is indistinguishable from
 * "there are no categories yet", which sends the user off to create one that
 * already exists.
 */
export function ReferenceField({ field, value, error, onChange }) {
  const [state, setState] = useState({ rows: [], loading: true, failed: false });

  useEffect(() => {
    let cancelled = false;
    api.get(`/${field.endpoint}`, { params: { limit: 200, status: 'ACTIVE' } })
      .then((res) => !cancelled && setState({ rows: res.data.data, loading: false, failed: false }))
      .catch(() => !cancelled && setState({ rows: [], loading: false, failed: true }));
    return () => { cancelled = true; };
  }, [field.endpoint]);

  const label = (r) => field.optionLabel?.(r)
    ?? [r.code ?? r.sku ?? r.vendorCode ?? r.customerCode, r.name ?? r.vendorName ?? r.customerName]
      .filter(Boolean).join(' — ');

  if (state.failed) {
    return (
      <div>
        <Label field={field}>
          <select disabled className={`${baseInput} border-line-strong bg-slate-100 text-ink-muted`}>
            <option>Could not load {field.label.toLowerCase()}</option>
          </select>
        </Label>
      </div>
    );
  }

  return (
    <div>
      <Label field={field}>
        <select
          value={value ?? ''}
          disabled={state.loading}
          onChange={(e) => onChange(e.target.value || null)}
          className={`${baseInput} ${borderFor(error)} bg-white disabled:bg-paper`}
        >
          <option value="">{state.loading ? 'Loading…' : '—'}</option>
          {state.rows.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
        </select>
      </Label>
      {!state.loading && state.rows.length === 0 && (
        <span className="mt-1 block text-xs text-amber-700">
          None exist yet — create one first.
        </span>
      )}
      <Error error={error} />
    </div>
  );
}

const ADDRESS_PARTS = [
  ['line1', 'Address line 1'], ['line2', 'Line 2'], ['city', 'City'],
  ['state', 'State'], ['postalCode', 'PIN code'], ['country', 'Country'],
];

export function AddressField({ field, value, errors = {}, onChange }) {
  const set = (key, v) => onChange({ ...(value ?? {}), [key]: v || undefined });

  return (
    <fieldset className="rounded-md border border-line p-3">
      <legend className="px-1 text-xs font-medium text-ink-soft">{field.label}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {ADDRESS_PARTS.map(([key, label]) => (
          <div key={key} className={key.startsWith('line') ? 'sm:col-span-2' : ''}>
            <input
              value={value?.[key] ?? ''}
              placeholder={label}
              onChange={(e) => set(key, e.target.value)}
              className={`${baseInput} ${borderFor(errors[`${field.name}.${key}`])}`}
            />
            <Error error={errors[`${field.name}.${key}`]} />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Repeating key/value rows — a product's specifications.
 *
 * Rows with a blank key are dropped on submit rather than sent: an empty
 * specification is noise on every screen that renders the product afterwards.
 */
export function KeyValueField({ field, value, onChange }) {
  // `?? []` not a default parameter: a default only fires for `undefined`.
  const current = value ?? [];
  const rows = current.length > 0 ? current : [{ key: '', value: '' }];
  const set = (i, patch) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <fieldset className="rounded-md border border-line p-3">
      <legend className="px-1 text-xs font-medium text-ink-soft">{field.label}</legend>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={row.key ?? ''} placeholder="Name (e.g. Ports)"
              onChange={(e) => set(i, { key: e.target.value })}
              className={`${baseInput} border-line-strong`}
            />
            <input
              value={row.value ?? ''} placeholder="Value (e.g. 24)"
              onChange={(e) => set(i, { value: e.target.value })}
              className={`${baseInput} border-line-strong`}
            />
            <button
              type="button" aria-label="Remove"
              onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              className="rounded-md px-2 text-ink-muted hover:bg-paper hover:text-ink-soft"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="mt-2 inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
      >
        <Plus className="h-3.5 w-3.5" /> Add row
      </button>
    </fieldset>
  );
}

/** Warehouse racks: a code and an optional description per rack. */
export function RacksField({ field, value, onChange }) {
  const current = value ?? [];
  const set = (i, patch) => onChange(current.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <fieldset className="rounded-md border border-line p-3">
      <legend className="px-1 text-xs font-medium text-ink-soft">{field.label}</legend>
      {current.length === 0 && (
        <p className="text-xs text-ink-muted">
          No racks. Stock can still be received — a rack is a location label, not a requirement.
        </p>
      )}
      <div className="space-y-2">
        {current.map((rack, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={rack.code ?? ''} placeholder="RACK-01"
              onChange={(e) => set(i, { code: e.target.value.toUpperCase() })}
              className={`${baseInput} border-line-strong font-mono`}
            />
            <input
              value={rack.description ?? ''} placeholder="Description"
              onChange={(e) => set(i, { description: e.target.value })}
              className={`${baseInput} border-line-strong`}
            />
            <button
              type="button" aria-label="Remove rack"
              onClick={() => onChange(current.filter((_, idx) => idx !== i))}
              className="rounded-md px-2 text-ink-muted hover:bg-paper hover:text-ink-soft"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...current, { code: '', description: '' }])}
        className="mt-2 inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
      >
        <Plus className="h-3.5 w-3.5" /> Add rack
      </button>
    </fieldset>
  );
}

export const FIELD_COMPONENTS = {
  text: TextField,
  textarea: TextAreaField,
  number: NumberField,
  select: SelectField,
  checkbox: CheckboxField,
  reference: ReferenceField,
  address: AddressField,
  keyvalue: KeyValueField,
  racks: RacksField,
};
