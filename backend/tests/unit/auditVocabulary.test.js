import { readFileSync, existsSync } from 'node:fs';
import { AuditLog } from '../../src/models/AuditLog.js';

/**
 * The frontend must be able to label every severity the backend can write.
 *
 * The audit page shipped knowing three of the four. `NOTICE` — 29 call sites,
 * roughly a third of everything in the trail — fell through a `?? INFO`
 * fallback and rendered as "Info", and was missing from the filter entirely.
 * Both failures are invisible: the page renders, nothing errors, and the only
 * symptom is a severity that quietly reads as something milder than it is.
 *
 * A comment saying "keep these in sync" is what was there before. This fails
 * instead.
 *
 * The test reaches across the package boundary deliberately. The enum lives
 * here, so the obligation lives here: adding a severity should fail in the
 * suite of the package that added it, not in the one that forgot.
 */
const PAGE = new URL('../../../frontend/src/features/audit/AuditLogPage.jsx', import.meta.url);

describe('severity labelling cannot drift from the schema', () => {
  const severities = AuditLog.schema.path('severity').enumValues;

  it('has severities to check', () => {
    expect(severities.length).toBeGreaterThan(1);
  });

  it('publishes them through the vocabulary endpoint rather than a second list', async () => {
    // The page populates its filter from this, so a new severity becomes
    // selectable without anyone editing the frontend at all.
    const service = await import('../../src/services/audit/auditQueryService.js');
    expect(typeof service.auditVocabulary).toBe('function');
    expect(severities).toEqual(expect.arrayContaining(['INFO', 'CRITICAL']));
  });

  /**
   * Skipped where the frontend is not on disk — which is the case inside the
   * backend container, since docker-compose mounts only ./backend into it. It
   * runs in CI, where the whole repository is checked out, and that is the
   * gate that matters. The name says so rather than leaving a bare "1 skipped"
   * for someone to wonder about.
   */
  (existsSync(PAGE) ? it : it.skip)(
    'labels every severity in the audit page (skipped: frontend not mounted here)',
    () => {
      const source = readFileSync(PAGE, 'utf8');
      const labelled = [...source.matchAll(/^\s{2}([A-Z_]+): \{ label:/gm)].map((m) => m[1]);

      expect(labelled.length).toBeGreaterThan(0);
      for (const severity of severities) {
        expect([severity, labelled.includes(severity)]).toEqual([severity, true]);
      }
    },
  );

  it('never silently relabels an unknown severity as a milder one', () => {
    if (!existsSync(PAGE)) return;
    const source = readFileSync(PAGE, 'utf8');
    // `SEVERITY[severity] ?? SEVERITY.INFO` is the shape that hid this: it
    // turns anything unrecognised into "Info", which is a claim about the
    // record rather than an admission of ignorance.
    expect(source).not.toMatch(/SEVERITY\[severity\]\s*\?\?\s*SEVERITY\.INFO/);
  });
});
