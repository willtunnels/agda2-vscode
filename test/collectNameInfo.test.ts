/**
 * Integration test for collectNameInfo: spawns a real Agda process, loads a
 * fixture with deeply nested modules, a record containing a module, anonymous
 * modules, a data type, and an empty module, then runs the recursive walker
 * against the live session.
 *
 * Verifies:
 *   - types bind to DefIds at every depth (including inside records and
 *     inside modules inside anonymous modules)
 *   - empty def-tree containers are skipped (no `Empty` round-trip)
 *   - data types are skipped (no `Outer.Middle.Inner.InnerData` round-trip)
 *   - anonymous `module _` is transparent (qualified path `Anon.AnonInner`
 *     works with plain concatenation, no `_` segment)
 *
 * Runs against all available Agda versions (downloaded by globalSetup).
 */

import { describe, it, expect, inject } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { Uri, MockTextDocument } from "./__mocks__/vscode.js";
import type { HighlightingPayload } from "../src/agda/responses.js";
import { SessionState } from "../src/core/sessionState.js";
import { buildDefTree } from "../src/providers/defTree.js";
import { collectNameInfo, type FetchModuleContents } from "../src/providers/nameMatching.js";
import { spawnAgda, haskellStringQuote } from "./helpers/agdaSession.js";

const agdaBinaries = inject("agdaBinaries");
const fixturePath = path.resolve(path.join(__dirname, "fixtures", "NameInfoNested.agda"));
const semicolonFixturePath = path.resolve(
  path.join(__dirname, "fixtures", "NameInfoSemicolons.agda"),
);

for (const { version, binaryPath } of agdaBinaries) {
  describe(`collectNameInfo -- Agda v${version}`, () => {
    it("recursively attaches types across modules, records, and anon modules; prunes empties and datatypes", async () => {
      const session = await spawnAgda(binaryPath);
      try {
        // Load the fixture and capture all HighlightingInfo payloads.
        const loadCmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_load ${haskellStringQuote(fixturePath)} [])`;
        const loadResponses = await session.sendCommand(loadCmd);

        const content = fs.readFileSync(fixturePath, "utf-8");
        const docUri = Uri.file(fixturePath);
        const doc = MockTextDocument.create(docUri, content, "agda");

        const ss = new SessionState();
        for (const r of loadResponses) {
          if (r.kind === "HighlightingInfo" && r.direct) {
            ss.applyHighlighting(doc, r.info as HighlightingPayload);
          }
        }

        const tree = buildDefTree(ss.getEntries(doc.uri.toString()), doc);
        expect(tree.length).toBeGreaterThan(0);

        // Tracking fetcher that routes through the live Agda session.
        const fetches: string[] = [];
        const fetch: FetchModuleContents = async (qname) => {
          fetches.push(qname);
          const cmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_show_module_contents_toplevel Simplified ${haskellStringQuote(qname)})`;
          const responses = await session.sendCommand(cmd);
          for (const r of responses) {
            if (r.kind === "DisplayInfo" && r.info.kind === "ModuleContents") {
              return { contents: r.info.contents, names: r.info.names };
            }
          }
          return undefined;
        };

        const result = await collectNameInfo(doc, tree, fetch);

        // Exactly these eight qualified names should be fetched; nothing more.
        // `Empty` is pruned (no children in def tree); `InnerData` is pruned
        // (atom is `datatype`, its constructor is already bound at the
        // enclosing `Outer.Middle.Inner` scope).
        expect([...fetches].sort()).toEqual([
          "",
          "Anon",
          "Anon.AnonInner",
          "Outer",
          "Outer.Middle",
          "Outer.Middle.Inner",
          "Pair",
          "Pair.InsideRec",
        ]);
        expect(fetches).not.toContain("Empty");
        expect(fetches).not.toContain("Outer.Middle.Inner.InnerData");

        // Every definition that Agda surfaces in `contents` at some scope
        // should show up bound in the result (by source name).
        const byName = new Map<string, string | undefined>();
        for (const [, info] of result) byName.set(info.name, info.type);

        // Top-level record (from `""` contents).
        expect(byName.get("Pair")).toBe("Set₁");

        // Module-chain values, each from its own qualified scope.
        expect(byName.get("outerVal")).toBe("Set₁");
        expect(byName.get("middleVal")).toBe("Set₁");
        expect(byName.get("innerVal")).toBe("Set₁");

        // Data type and its constructor, both from `Outer.Middle.Inner`.
        expect(byName.get("InnerData")).toBe("Set");
        expect(byName.get("innerCon")).toBe("Outer.Middle.Inner.InnerData");

        // Record fields (Pi-typed through the record parameter).
        expect(byName.get("fst")).toBe("Pair → Set");
        expect(byName.get("snd")).toBe("Pair → Set");

        // Module nested inside a record -- still reachable.
        expect(byName.get("insideVal")).toBe("Pair → Set₁");

        // Entries inside an anonymous parametrized module: the `A : Set`
        // parameter is threaded through, and the qualified path skips `_`.
        expect(byName.get("anonVal")).toBe("Set → Set");
        expect(byName.get("anonInnerVal")).toBe("Set → Set");
      } finally {
        session.close();
      }
    }, 60000);

    /**
     * buildDefTree uses a column-stack heuristic: a decl at a greater column
     * than the stack top becomes its child. Agda's layout rule normally
     * forces siblings to align, so the heuristic matches the semantics. But
     * Agda *also* accepts semicolon-separated decls on one line (`foo = Set
     * ; qux : Set₁`), where the second identifier's column is far to the
     * right of the first's. In our tree, that nests the second under the
     * first -- a structural misparent.
     *
     * This test locks in two things:
     *   1. The misparent is real (qux ends up as baz's child in the tree).
     *   2. `collectNameInfo` is nonetheless *robust* to it: matchContents
     *      walks the scope's full subtree via walkDefTree, so both names
     *      still bind to their correct types at module-N's scope.
     *
     * In other words, the outline view would render qux nested under baz,
     * but hover type info remains correct.
     */
    it("tolerates semicolon-separated decls (misparented in tree, still bound correctly)", async () => {
      const session = await spawnAgda(binaryPath);
      try {
        const loadCmd = `IOTCM ${haskellStringQuote(semicolonFixturePath)} NonInteractive Indirect (Cmd_load ${haskellStringQuote(semicolonFixturePath)} [])`;
        const loadResponses = await session.sendCommand(loadCmd);

        const content = fs.readFileSync(semicolonFixturePath, "utf-8");
        const docUri = Uri.file(semicolonFixturePath);
        const doc = MockTextDocument.create(docUri, content, "agda");

        const ss = new SessionState();
        for (const r of loadResponses) {
          if (r.kind === "HighlightingInfo" && r.direct) {
            ss.applyHighlighting(doc, r.info as HighlightingPayload);
          }
        }

        const tree = buildDefTree(ss.getEntries(doc.uri.toString()), doc);

        // --- Confirm the structural bug: qux ends up nested under baz ---
        // Find N among the tree roots.
        const nNode = tree.find((n) => doc.getText(n.entry.range) === "N");
        expect(nNode, "expected N module as a tree root").toBeDefined();

        const nChildNames = nNode!.children.map((c) => doc.getText(c.entry.range));
        // Semantically, `N` should have [baz, qux] as direct children.
        // Column-stack heuristic gives us only [baz] -- qux lost to baz.
        expect(nChildNames).toEqual(["baz"]);

        const bazNode = nNode!.children[0];
        const bazChildNames = bazNode.children.map((c) => doc.getText(c.entry.range));
        expect(bazChildNames).toContain("qux");

        // --- Confirm collectNameInfo still binds both correctly ---
        const fetch: FetchModuleContents = async (qname) => {
          const cmd = `IOTCM ${haskellStringQuote(semicolonFixturePath)} NonInteractive Indirect (Cmd_show_module_contents_toplevel Simplified ${haskellStringQuote(qname)})`;
          const responses = await session.sendCommand(cmd);
          for (const r of responses) {
            if (r.kind === "DisplayInfo" && r.info.kind === "ModuleContents") {
              return { contents: r.info.contents, names: r.info.names };
            }
          }
          return undefined;
        };

        const result = await collectNameInfo(doc, tree, fetch);
        const byName = new Map<string, string | undefined>();
        for (const [, info] of result) byName.set(info.name, info.type);

        // matchContents walks the whole subtree via walkDefTree, so even
        // though qux is misparented under baz, the name lookup still
        // succeeds at N's scope.
        expect(byName.get("baz")).toBe("Set₁");
        expect(byName.get("qux")).toBe("Set₁");
      } finally {
        session.close();
      }
    }, 60000);
  });
}
