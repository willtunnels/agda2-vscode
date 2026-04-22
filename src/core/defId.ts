// Opaque identifier for an Agda definition.
//
// The underlying runtime representation is a number, but the type is opaque
// (no `number &` -- this module is the only place where the cast happens).
// Consumers cannot add, subtract, compare with <.  The intended API surface is
// defIdEq and Map<DefId, _> lookups.

declare const DefIdTag: unique symbol;
export type DefId = { readonly [DefIdTag]: never };

/** Mint a DefId from an Agda offset. Call site should be limited to ingestion. */
export function makeDefId(n: number): DefId {
  return n as unknown as DefId;
}

export function defIdEq(a: DefId, b: DefId): boolean {
  return (a as unknown as number) === (b as unknown as number);
}
