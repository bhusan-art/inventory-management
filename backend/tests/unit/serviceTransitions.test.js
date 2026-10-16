import { SERVICE_TRANSITIONS, canMoveService } from '../../src/models/ServiceRequest.js';

const STATUSES = Object.keys(SERVICE_TRANSITIONS);

describe('service ticket transition table', () => {
  it('checks every ordered pair against the table', () => {
    const unexpected = [];
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (canMoveService(from, to) !== SERVICE_TRANSITIONS[from].includes(to)) {
          unexpected.push(`${from}->${to}`);
        }
      }
    }
    expect(unexpected).toEqual([]);
  });

  it('only ever targets a real status', () => {
    for (const [from, targets] of Object.entries(SERVICE_TRANSITIONS)) {
      for (const to of targets) {
        expect({ from, to, known: STATUSES.includes(to) }).toEqual({ from, to, known: true });
      }
    }
  });

  it('treats CLOSED as terminal', () => {
    expect(SERVICE_TRANSITIONS.CLOSED).toEqual([]);
    for (const to of STATUSES) expect(canMoveService('CLOSED', to)).toBe(false);
  });

  it('never allows a status to move to itself', () => {
    for (const status of STATUSES) expect(canMoveService(status, status)).toBe(false);
  });

  it('requires inspection before repair — a ticket cannot jump from OPEN', () => {
    expect(canMoveService('OPEN', 'UNDER_REPAIR')).toBe(false);
    expect(canMoveService('OPEN', 'REPAIRED')).toBe(false);
    expect(canMoveService('OPEN', 'UNDER_INSPECTION')).toBe(true);
  });

  it('allows a replacement from any working state but not from OPEN', () => {
    expect(canMoveService('OPEN', 'REPLACED')).toBe(false);
    for (const from of ['UNDER_INSPECTION', 'SENT_TO_VENDOR', 'UNDER_REPAIR']) {
      expect(canMoveService(from, 'REPLACED')).toBe(true);
    }
  });

  it('lets every resolution reach CLOSED', () => {
    for (const from of ['REPAIRED', 'REPLACED', 'REJECTED']) {
      expect(canMoveService(from, 'CLOSED')).toBe(true);
    }
  });

  it('does not allow reopening a resolved ticket', () => {
    // Reopening would make a closed ticket's resolution and the unit's
    // location disagree; the correct move is a new ticket.
    for (const from of ['REPAIRED', 'REPLACED']) {
      expect(canMoveService(from, 'UNDER_REPAIR')).toBe(false);
      expect(canMoveService(from, 'OPEN')).toBe(false);
    }
  });
});
