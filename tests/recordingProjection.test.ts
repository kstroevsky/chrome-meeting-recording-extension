import { projectPhase } from '../src/shared/recording';
import type { DesiredState, ObservedState, RecordingPhase } from '../src/shared/recording';

const ALL_OBSERVED: ObservedState[] = ['none', 'starting', 'recording', 'stopping', 'uploading', 'idle'];
const ALL_DESIRED: DesiredState[] = ['idle', 'recording'];

describe('projectPhase (ADR-0003 Decision 4)', () => {
  describe('terminal failure wins over every input', () => {
    for (const desired of ALL_DESIRED) {
      for (const observed of ALL_OBSERVED) {
        it(`desired=${desired} observed=${observed} failed=true → failed`, () => {
          expect(projectPhase(desired, observed, true)).toBe('failed');
        });
      }
    }
  });

  describe('exhaustive desired × observed table (failed=false)', () => {
    // The full, hand-checked projection. Every input combination is listed so a
    // change to projectPhase that alters any cell breaks a named test.
    const table: Array<[DesiredState, ObservedState, RecordingPhase]> = [
      // Want to record: only truly `recording` once the offscreen confirms it;
      // every other observation means observation hasn't caught up → `starting`.
      ['recording', 'none', 'starting'],
      ['recording', 'starting', 'starting'],
      ['recording', 'recording', 'recording'],
      ['recording', 'stopping', 'starting'],
      ['recording', 'uploading', 'starting'],
      ['recording', 'idle', 'starting'],
      // Want idle: the recorder may still be draining capture or uploading.
      ['idle', 'none', 'idle'],
      ['idle', 'starting', 'stopping'],
      ['idle', 'recording', 'stopping'],
      ['idle', 'stopping', 'stopping'],
      ['idle', 'uploading', 'uploading'],
      ['idle', 'idle', 'idle'],
    ];

    for (const [desired, observed, expected] of table) {
      it(`desired=${desired} observed=${observed} → ${expected}`, () => {
        expect(projectPhase(desired, observed, false)).toBe(expected);
      });
    }

    it('covers every desired × observed combination exactly once', () => {
      expect(table).toHaveLength(ALL_DESIRED.length * ALL_OBSERVED.length);
      const keys = new Set(table.map(([d, o]) => `${d}/${o}`));
      expect(keys.size).toBe(table.length);
    });
  });

  // The canonical decomposition of each of the six displayed phases. Step 3's
  // storage migration (normalizeSessionSnapshot) reconstructs (desired, observed,
  // failed) from a legacy persisted `phase` using exactly this mapping, so the
  // projected phase must round-trip back to the original.
  describe('round-trips each displayed phase through its (desired, observed, failed) decomposition', () => {
    const decompositions: Array<[RecordingPhase, DesiredState, ObservedState, boolean]> = [
      ['idle', 'idle', 'idle', false],
      ['starting', 'recording', 'none', false],
      ['recording', 'recording', 'recording', false],
      ['stopping', 'idle', 'recording', false],
      ['uploading', 'idle', 'uploading', false],
      ['failed', 'idle', 'none', true],
    ];

    for (const [phase, desired, observed, failed] of decompositions) {
      it(`${phase} ← (${desired}, ${observed}, failed=${failed})`, () => {
        expect(projectPhase(desired, observed, failed)).toBe(phase);
      });
    }
  });
});
