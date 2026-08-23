/**
 * Property test for the reconciliation engine.
 *
 * Drives the rewriter with seeded-random op sequences (typing, backspace,
 * pastes, arbitrary replacements, cursor moves, cycling, delete, replace-all,
 * flushes) against a simulated document, and checks the invariants the
 * design promises:
 *
 *   (A) at all times, every tracked abbreviation's `shown` equals the
 *       document content of its span;
 *   (B) after a quiescent flush, every tracked abbreviation satisfies
 *       `desired === shown`, only active abbreviations remain, and spans
 *       are disjoint;
 *   (C) a second flush performs no writes (reconciliation is idempotent).
 */

import { describe, it } from "vitest";
import {
  AbbreviationRewriter,
  AbbreviationTextSource,
  Change,
} from "../src/unicode/engine/AbbreviationRewriter";
import { AbbreviationProvider } from "../src/unicode/engine/AbbreviationProvider";
import { Range } from "../src/unicode/engine/Range";

/** Deterministic PRNG (mulberry32) so failures are reproducible by seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text source over a plain string, applying engine writes like an editor. */
class PropSource implements AbbreviationTextSource {
  text = "";
  selections: Range[] = [new Range(0, 0)];
  replaceCount = 0;

  async replaceAbbreviations(changes: Change[]): Promise<boolean> {
    this.replaceCount++;
    const sorted = [...changes].sort((a, b) => b.range.start - a.range.start);
    for (const c of sorted) {
      this.text =
        this.text.slice(0, c.range.start) +
        c.newText +
        this.text.slice(c.range.start + c.range.length);
    }
    return true;
  }

  collectSelections(): Range[] {
    return this.selections;
  }

  setSelections(selections: Range[]): void {
    this.selections = selections;
  }
}

const SEEDS = 300;
const OPS_PER_SEED = 40;

// Characters biased toward real abbreviation prefixes (t/to/top/times/...),
// plus the leader, junk, and space.
const CHARS = ["\\", "t", "o", "p", "i", "m", "e", "s", "a", "l", "b", "x", " "];
const PASTES = ["op", "to", "es", "\\to", "xy"];

describe("AbbreviationRewriter properties", () => {
  it("random op sequences preserve the reconciliation invariants", async () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const rand = mulberry32(seed);
      const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

      // Multi-symbol "t" so cycling is exercised by a single keystroke.
      const provider = new AbbreviationProvider({ t: ["T1", "T2", "T3"] });
      const source = new PropSource();
      const rewriter = new AbbreviationRewriter("\\", provider, source);
      const log: string[] = [];

      const fail = (msg: string): never => {
        throw new Error(
          `seed ${seed}: ${msg}\n` +
            `document: ${JSON.stringify(source.text)}\n` +
            `ops:\n  ${log.join("\n  ")}`,
        );
      };

      // Invariant (A): `shown` mirrors the document, and spans are in bounds.
      const checkMirror = (when: string): void => {
        for (const abbr of rewriter.getTrackedAbbreviations()) {
          if (abbr.start < 0 || abbr.start + abbr.shown.length > source.text.length) {
            fail(`${when}: span [${abbr.start}, +${abbr.shown.length}) out of bounds`);
          }
          const inDoc = source.text.slice(abbr.start, abbr.start + abbr.shown.length);
          if (inDoc !== abbr.shown) {
            fail(
              `${when}: shown ${JSON.stringify(abbr.shown)} != document slice ` +
                `${JSON.stringify(inDoc)} at ${abbr.start}`,
            );
          }
        }
      };

      const cursor = (): number => {
        const s = source.selections[0] ?? new Range(0, 0);
        return Math.min(s.start + s.length, source.text.length);
      };

      // A user edit: apply to the document, move the cursor to its end, feed
      // the change and the follow-up selection event to the engine (the same
      // event pair the VS Code adapter forwards).
      const applyUserEdit = (range: Range, newText: string): void => {
        source.text =
          source.text.slice(0, range.start) +
          newText +
          source.text.slice(range.start + range.length);
        source.selections = [new Range(range.start + newText.length, 0)];
        rewriter.changeInput([{ range, newText }]);
        rewriter.changeSelections(source.selections);
      };

      for (let i = 0; i < OPS_PER_SEED; i++) {
        const r = rand();
        if (r < 0.34) {
          const ch = pick(CHARS);
          log.push(`type ${JSON.stringify(ch)} @${cursor()}`);
          applyUserEdit(new Range(cursor(), 0), ch);
        } else if (r < 0.48) {
          const pos = cursor();
          if (pos > 0) {
            log.push(`backspace @${pos - 1}`);
            applyUserEdit(new Range(pos - 1, 1), "");
          }
        } else if (r < 0.54) {
          const s = pick(PASTES);
          log.push(`paste ${JSON.stringify(s)} @${cursor()}`);
          applyUserEdit(new Range(cursor(), 0), s);
        } else if (r < 0.6) {
          // Arbitrary small replacement anywhere (can straddle spans).
          const start = Math.floor(rand() * (source.text.length + 1));
          const len = Math.min(source.text.length - start, Math.floor(rand() * 3));
          const newText = rand() < 0.5 ? "" : pick(CHARS);
          log.push(`replace [${start}, +${len}) with ${JSON.stringify(newText)}`);
          applyUserEdit(new Range(start, len), newText);
        } else if (r < 0.7) {
          const pos = Math.floor(rand() * (source.text.length + 1));
          log.push(`cursor -> ${pos}`);
          source.selections = [new Range(pos, 0)];
          rewriter.changeSelections(source.selections);
        } else if (r < 0.78) {
          const dir: 1 | -1 = rand() < 0.5 ? 1 : -1;
          log.push(`cycle ${dir}`);
          rewriter.cycleAbbreviations(dir);
        } else if (r < 0.83) {
          log.push("deleteAbbreviations");
          rewriter.deleteAbbreviations();
        } else if (r < 0.86) {
          log.push("replaceAll");
          rewriter.replaceAllTrackedAbbreviations();
        } else {
          log.push("flush");
          await rewriter.flushDirty();
        }
        checkMirror(`after op ${i} (${log[log.length - 1]})`);
      }

      // Quiesce and check invariant (B).
      log.push("final flush");
      await rewriter.flushDirty();
      checkMirror("after final flush");

      const tracked = [...rewriter.getTrackedAbbreviations()].sort((a, b) => a.start - b.start);
      for (const abbr of tracked) {
        if (abbr.desired !== abbr.shown) {
          fail(
            `desired ${JSON.stringify(abbr.desired)} != shown ` +
              `${JSON.stringify(abbr.shown)} after quiescent flush (text=${abbr.text})`,
          );
        }
        if (abbr.status !== "active") {
          fail(`non-active abbreviation (${abbr.status}) survived the flush`);
        }
      }
      for (let k = 1; k < tracked.length; k++) {
        const prev = tracked[k - 1];
        if (prev.start + prev.shown.length > tracked[k].start) {
          fail(`overlapping spans at ${prev.start} and ${tracked[k].start}`);
        }
      }

      // Invariant (C): a second flush writes nothing.
      const writesBefore = source.replaceCount;
      await rewriter.flushDirty();
      if (source.replaceCount !== writesBefore) {
        fail("second flush performed writes (reconciliation not idempotent)");
      }
    }
  });
});
