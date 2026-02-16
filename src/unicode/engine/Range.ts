// Copyright 2021 Microsoft Corporation and the Lean community contributors.
// SPDX-License-Identifier: Apache-2.0
//
// Adapted from https://github.com/leanprover/vscode-lean4
// (lean4-unicode-input/src/Range.ts)
// Modified for Agda

/**
 * A general purpose range implementation.
 * Is offset/length based in contrast to `vscode.Range` which is line/column based.
 */
export class Range {
  constructor(
    readonly start: number,
    readonly length: number,
  ) {
    if (length < 0) {
      throw new Error("`Range` length cannot be negative");
    }
  }

  get endInclusive(): number {
    return this.start + this.length - 1;
  }

  move(delta: number): Range {
    return new Range(this.start + delta, this.length);
  }

  moveStart(delta: number): Range {
    if (delta > this.length) {
      throw new Error("`Range` start cannot be moved past the end");
    }
    return new Range(this.start + delta, this.length - delta);
  }

  moveEnd(delta: number): Range {
    return new Range(this.start, this.length + delta);
  }

  withLength(newLength: number): Range {
    return new Range(this.start, newLength);
  }

  containsRange(other: Range): boolean {
    return this.start <= other.start && other.endInclusive <= this.endInclusive;
  }

  isAfter(range: Range): boolean {
    return range.endInclusive < this.start;
  }

  isBefore(range: Range): boolean {
    return range.start > this.endInclusive;
  }

  equals(other: Range): boolean {
    return this.start === other.start && this.length === other.length;
  }
}
