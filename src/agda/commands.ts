// IOTCM command builders. Pure functions producing command strings.
//
// Version-compatibility notes
// ===========================
//
//  Version        | Change                             | Status
//  ---------------|------------------------------------|------------------------------------------------------------------------------
//  2.6.1->2.6.2   | Cmd_metas gained Rewrite arg       | Gated with V2_6_2
//  2.6.1->2.6.2   | ToggleIrrelevantArgs added         | OK -- user-initiated, graceful failure on 2.6.1
//  2.6.1->2.6.2   | Info_Error JSON restructured       | We call normalizeResponse
//  2.6.1->2.6.2   | Status gained showIrrelevantArgs   | OK -- field defined but unused
//  2.6.2->2.6.3   | SrcFile -> RangeFile               | No impact -- only affects ranges we send, and only Cmd_highlight sends ranges
//  2.6.4.3->2.7.0 | Cmd_autoOne/All gained Rewrite     | Gated with V2_7
//  2.6.4.3->2.7.0 | Resp_Mimer response added          | OK -- silently ignored, auto results come via DisplayInfo
//  2.7.0.1->2.8.0 | Interval' 2->3 fields              | Gated with V2_8
//  2.7.0.1->2.8.0 | Cmd_no_metas -> Cmd_load_no_metas  | OK -- both builders exist, neither currently used
//  2.7.0.1->2.8.0 | JumpToError Int32->Word32          | OK -- abstracted as AgdaOffset

import { haskellStringQuote, haskellListQuote, iotcm } from "../util/iotcm.js";
import { fromAgdaOffset, type AgdaOffset } from "../util/offsets.js";
import { type AgdaVersion, versionGte, V2_6_2, V2_7, V2_8 } from "./version.js";

export type Rewrite = "AsIs" | "Instantiated" | "HeadNormal" | "Simplified" | "Normalised";
export type ComputeMode = "DefaultCompute" | "HeadCompute" | "IgnoreAbstract" | "UseShowInstance";

/**
 * Load/typecheck a file.
 * Cmd_load "<filepath>" [<flags>]
 */
export function cmdLoad(filepath: string, extraArgs: string[] = []): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_load ${haskellStringQuote(filepath)} ${haskellListQuote(extraArgs)}`,
  );
}

/**
 * Give (fill a goal with an expression).
 * Cmd_give <UseForce> <goalId> noRange "<expr>"
 */
export function cmdGive(filepath: string, goalId: number, expr: string, force = false): string {
  const useForce = force ? "WithForce" : "WithoutForce";
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_give ${useForce} ${goalId} noRange ${haskellStringQuote(expr)}`,
  );
}

/**
 * Refine a goal.
 * Cmd_refine_or_intro <Bool> <goalId> noRange "<expr>"
 *
 * When pmlambda is true and the goal has a functional type, Agda inserts
 * a pattern-matching lambda (λ { pat → ? }) instead of a regular lambda.
 * In Emacs this is triggered by the C-u prefix argument.
 */
export function cmdRefine(
  filepath: string,
  goalId: number,
  expr: string,
  pmlambda = false,
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_refine_or_intro ${pmlambda ? "True" : "False"} ${goalId} noRange ${haskellStringQuote(expr)}`,
  );
}

/**
 * Case split on a variable.
 * Cmd_make_case <goalId> noRange "<variable>"
 */
export function cmdMakeCase(filepath: string, goalId: number, variable: string): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_make_case ${goalId} noRange ${haskellStringQuote(variable)}`,
  );
}

/**
 * Show goal type.
 * Cmd_goal_type <Rewrite> <goalId> noRange ""
 */
export function cmdGoalType(
  filepath: string,
  goalId: number,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(filepath, "NonInteractive", `Cmd_goal_type ${rewrite} ${goalId} noRange ""`);
}

/**
 * Show goal type and context.
 * Cmd_goal_type_context <Rewrite> <goalId> noRange ""
 */
export function cmdGoalTypeContext(
  filepath: string,
  goalId: number,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(filepath, "NonInteractive", `Cmd_goal_type_context ${rewrite} ${goalId} noRange ""`);
}

/**
 * Show goal type, context, and inferred type of expression.
 * Cmd_goal_type_context_infer <Rewrite> <goalId> noRange "<expr>"
 */
export function cmdGoalTypeContextInfer(
  filepath: string,
  goalId: number,
  expr: string,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_goal_type_context_infer ${rewrite} ${goalId} noRange ${haskellStringQuote(expr)}`,
  );
}

/**
 * Show context at a goal.
 * Cmd_context <Rewrite> <goalId> noRange ""
 */
export function cmdContext(
  filepath: string,
  goalId: number,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(filepath, "NonInteractive", `Cmd_context ${rewrite} ${goalId} noRange ""`);
}

/**
 * Infer type of expression in a goal.
 * Cmd_infer <Rewrite> <goalId> noRange "<expr>"
 */
export function cmdInfer(
  filepath: string,
  goalId: number,
  expr: string,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_infer ${rewrite} ${goalId} noRange ${haskellStringQuote(expr)}`,
  );
}

/**
 * Infer type at top level.
 * Cmd_infer_toplevel <Rewrite> "<expr>"
 */
export function cmdInferToplevel(
  filepath: string,
  expr: string,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_infer_toplevel ${rewrite} ${haskellStringQuote(expr)}`,
  );
}

/**
 * Compute/normalize at top level.
 * Cmd_compute_toplevel <ComputeMode> "<expr>"
 */
export function cmdComputeToplevel(
  filepath: string,
  expr: string,
  mode: ComputeMode = "DefaultCompute",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_compute_toplevel ${mode} ${haskellStringQuote(expr)}`,
  );
}

/**
 * Compute/normalize in a goal.
 * Cmd_compute <ComputeMode> <goalId> noRange "<expr>"
 */
export function cmdCompute(
  filepath: string,
  goalId: number,
  expr: string,
  mode: ComputeMode = "DefaultCompute",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_compute ${mode} ${goalId} noRange ${haskellStringQuote(expr)}`,
  );
}

/**
 * Auto-solve one goal.
 * Agda < 2.7.0 (Agsy):  Cmd_autoOne <goalId> noRange <hint>
 * Agda >= 2.7.0 (Mimer): Cmd_autoOne <Rewrite> <goalId> noRange <hint>
 */
export function cmdAutoOne(
  filepath: string,
  goalId: number,
  version: AgdaVersion,
  rewrite: Rewrite = "AsIs",
): string {
  const inner = versionGte(version, V2_7)
    ? `Cmd_autoOne ${rewrite} ${goalId} noRange ""`
    : `Cmd_autoOne ${goalId} noRange ""`;
  return iotcm(filepath, "NonInteractive", inner);
}

/**
 * Auto-solve all goals.
 * Agda < 2.7.0 (Agsy):  Cmd_autoAll
 * Agda >= 2.7.0 (Mimer): Cmd_autoAll <Rewrite>
 */
export function cmdAutoAll(
  filepath: string,
  version: AgdaVersion,
  rewrite: Rewrite = "AsIs",
): string {
  const inner = versionGte(version, V2_7) ? `Cmd_autoAll ${rewrite}` : "Cmd_autoAll";
  return iotcm(filepath, "NonInteractive", inner);
}

/**
 * Solve all constraint-determined goals.
 * Cmd_solveAll <Rewrite>
 */
export function cmdSolveAll(filepath: string, rewrite: Rewrite = "AsIs"): string {
  return iotcm(filepath, "NonInteractive", `Cmd_solveAll ${rewrite}`);
}

/**
 * Solve one constraint-determined goal.
 * Cmd_solveOne <Rewrite> <goalId> noRange ""
 */
export function cmdSolveOne(filepath: string, goalId: number, rewrite: Rewrite = "AsIs"): string {
  return iotcm(filepath, "NonInteractive", `Cmd_solveOne ${rewrite} ${goalId} noRange ""`);
}

/**
 * Show constraints.
 * Cmd_constraints takes no arguments in Agda 2.6.1–2.8.x.
 * (A Rewrite argument is added on unreleased master / future 2.9+.)
 */
export function cmdConstraints(filepath: string): string {
  return iotcm(filepath, "NonInteractive", "Cmd_constraints");
}

/**
 * Show metas.
 * Agda < 2.6.2:  Cmd_metas
 * Agda >= 2.6.2: Cmd_metas <Rewrite>
 */
export function cmdMetas(
  filepath: string,
  version: AgdaVersion,
  rewrite: Rewrite = "AsIs",
): string {
  const inner = versionGte(version, V2_6_2) ? `Cmd_metas ${rewrite}` : "Cmd_metas";
  return iotcm(filepath, "NonInteractive", inner);
}

/**
 * Show module contents at top level.
 */
export function cmdShowModuleContentsToplevel(
  filepath: string,
  moduleName: string,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_show_module_contents_toplevel ${rewrite} ${haskellStringQuote(moduleName)}`,
  );
}

/**
 * Search about at top level.
 */
export function cmdSearchAboutToplevel(
  filepath: string,
  searchTerms: string,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_search_about_toplevel ${rewrite} ${haskellStringQuote(searchTerms)}`,
  );
}

/**
 * Why is a name in scope (at goal).
 */
export function cmdWhyInScope(filepath: string, goalId: number, name: string): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_why_in_scope ${goalId} noRange ${haskellStringQuote(name)}`,
  );
}

/**
 * Why is a name in scope (top level).
 */
export function cmdWhyInScopeToplevel(filepath: string, name: string): string {
  return iotcm(filepath, "NonInteractive", `Cmd_why_in_scope_toplevel ${haskellStringQuote(name)}`);
}

/**
 * Toggle implicit arguments display.
 */
export function cmdToggleImplicitArgs(filepath: string): string {
  return iotcm(filepath, "NonInteractive", "ToggleImplicitArgs");
}

/**
 * Abort current computation.
 */
export function cmdAbort(filepath: string): string {
  return iotcm(filepath, "NonInteractive", "Cmd_abort");
}

/**
 * Elaborate-check and give (fill a goal after type-checking the expression).
 * Cmd_elaborate_give <Rewrite> <goalId> noRange "<expr>"
 */
export function cmdElaborateGive(
  filepath: string,
  goalId: number,
  expr: string,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_elaborate_give ${rewrite} ${goalId} noRange ${haskellStringQuote(expr)}`,
  );
}

/**
 * Compute the type of a hypothetical helper function.
 * Cmd_helper_function <Rewrite> <goalId> noRange "<expr>"
 */
export function cmdHelperFunctionType(
  filepath: string,
  goalId: number,
  expr: string,
  rewrite: Rewrite = "AsIs",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_helper_function ${rewrite} ${goalId} noRange ${haskellStringQuote(expr)}`,
  );
}

/**
 * Show goal type, context, and checked type of expression.
 * Cmd_goal_type_context_check <Rewrite> <goalId> noRange "<expr>"
 */
export function cmdGoalTypeContextCheck(
  filepath: string,
  goalId: number,
  expr: string,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_goal_type_context_check ${rewrite} ${goalId} noRange ${haskellStringQuote(expr)}`,
  );
}

/**
 * Show module contents at a goal.
 * Cmd_show_module_contents <Rewrite> <goalId> noRange "<moduleName>"
 */
export function cmdShowModuleContents(
  filepath: string,
  goalId: number,
  moduleName: string,
  rewrite: Rewrite = "Simplified",
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_show_module_contents ${rewrite} ${goalId} noRange ${haskellStringQuote(moduleName)}`,
  );
}

/**
 * Toggle irrelevant arguments display.
 */
export function cmdToggleIrrelevantArgs(filepath: string): string {
  return iotcm(filepath, "NonInteractive", "ToggleIrrelevantArgs");
}

/**
 * Compile with a backend.
 * Cmd_compile <backend> "<filepath>" [<flags>]
 */
export function cmdCompile(filepath: string, backend: string, extraArgs: string[] = []): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_compile ${backend} ${haskellStringQuote(filepath)} ${haskellListQuote(extraArgs)}`,
  );
}

/**
 * Re-highlight a region after a give action.
 * Cmd_highlight <goalId> <range> "<text>"
 *
 * The range format changed in Agda 2.8.0: Interval' gained a separate file
 * field, so Position' no longer carries it.
 *
 *   Agda < 2.8:  Interval (Pn () off ln col) (Pn () off ln col)
 *   Agda >= 2.8: Interval () (Pn () off ln col) (Pn () off ln col)
 *
 * All positions are 1-based.
 */
export function cmdHighlight(
  filepath: string,
  goalId: number,
  fromOffset: AgdaOffset,
  fromLine: number,
  fromCol: number,
  toOffset: AgdaOffset,
  toLine: number,
  toCol: number,
  text: string,
  version: AgdaVersion,
): string {
  const fp = haskellStringQuote(filepath);
  const pnFrom = `Pn () ${fromAgdaOffset(fromOffset)} ${fromLine} ${fromCol}`;
  const pnTo = `Pn () ${fromAgdaOffset(toOffset)} ${toLine} ${toCol}`;
  // Agda 2.8+ Interval' has 3 fields (file, start, end).
  // Agda < 2.8 Interval' has 2 fields (start, end) with file inside Position'.
  const interval = versionGte(version, V2_8)
    ? `Interval () (${pnFrom}) (${pnTo})`
    : `Interval (${pnFrom}) (${pnTo})`;
  const range = `(intervalsToRange (Just (mkAbsolute ${fp})) [${interval}])`;
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_highlight ${goalId} ${range} ${haskellStringQuote(text)}`,
  );
}

/**
 * Show Agda version.
 */
export function cmdShowVersion(filepath: string): string {
  return iotcm(filepath, "NonInteractive", "Cmd_show_version");
}

/** Agda >= 2.8.0. Loads and checks for unsolved metas. */
export function cmdLoadNoMetas(filepath: string): string {
  return iotcm(filepath, "NonInteractive", `Cmd_load_no_metas ${haskellStringQuote(filepath)}`);
}

/** Agda < 2.8.0. Checks already-loaded file for unsolved metas. */
export function cmdNoMetas(filepath: string): string {
  return iotcm(filepath, "NonInteractive", "Cmd_no_metas");
}

/**
 * Run a backend's top-level interaction command.
 * Cmd_backend_top <backend> "<payload>"
 *
 * Requires Agda >= 2.8.0. Backends define custom interactive commands via
 * backendInteractTop; built-in backends currently leave this unimplemented.
 */
export function cmdBackendTop(filepath: string, backend: string, payload: string): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_backend_top ${backend} ${haskellStringQuote(payload)}`,
  );
}

/**
 * Run a backend's hole-level interaction command.
 * Cmd_backend_hole <goalId> noRange "<holeContents>" <backend> "<payload>"
 *
 * Requires Agda >= 2.8.0. Backends define custom interactive commands via
 * backendInteractHole; built-in backends currently leave this unimplemented.
 */
export function cmdBackendHole(
  filepath: string,
  goalId: number,
  holeContents: string,
  backend: string,
  payload: string,
): string {
  return iotcm(
    filepath,
    "NonInteractive",
    `Cmd_backend_hole ${goalId} noRange ${haskellStringQuote(holeContents)} ${backend} ${haskellStringQuote(payload)}`,
  );
}
