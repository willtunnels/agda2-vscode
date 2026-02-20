// The logic in this module is independent of the editor and can be used in any context.

export { SymbolsByAbbreviation, ExpansionKind, AbbreviationProvider } from "./AbbreviationProvider";
export { AbbreviationRewriter, AbbreviationTextSource, Change } from "./AbbreviationRewriter";
export { Range } from "./Range";
export { TrackedAbbreviation, ProcessChangeResult, CycleDirection } from "./TrackedAbbreviation";
