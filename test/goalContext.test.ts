/**
 * Integration test: spawns a real Agda process, loads a file with goals,
 * sends Cmd_goal_type_context for each goal, and verifies that the response
 * includes the expected context entries.
 *
 * This exercises the full round-trip: IOTCM command → Agda → JSON response →
 * our type definitions (GoalSpecific / GoalType / ResponseContextEntry).
 *
 * Runs against all available Agda versions (downloaded by globalSetup).
 */

import { describe, it, expect, inject } from "vitest";
import * as path from "path";
import {
  spawnAgda,
  haskellStringQuote,
  findDisplayInfo,
  findInteractionPoints,
} from "./helpers/agdaSession.js";

const agdaBinaries = inject("agdaBinaries");
const fixturePath = path.resolve(path.join(__dirname, "fixtures", "Goals.agda"));

for (const { version, binaryPath } of agdaBinaries) {
  describe(`Goal type and context — Agda v${version}`, () => {
    it("Cmd_goal_type_context returns GoalSpecific with GoalType kind", async () => {
      const agda = await spawnAgda(binaryPath);
      try {
        // Load the file
        const loadCmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_load ${haskellStringQuote(fixturePath)} [])`;
        const loadResponses = await agda.sendCommand(loadCmd);

        const goalIds = findInteractionPoints(loadResponses);
        expect(goalIds.length).toBeGreaterThanOrEqual(2);

        // Query goal type + context for each goal
        for (const goalId of goalIds) {
          const cmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_goal_type_context AsIs ${goalId} noRange "")`;
          const responses = await agda.sendCommand(cmd);
          const info = findDisplayInfo(responses);

          expect(info, `Expected DisplayInfo for goal ${goalId}`).toBeDefined();
          expect(info!.kind).toBe("GoalSpecific");

          if (info!.kind === "GoalSpecific") {
            const goalInfo = info!.goalInfo;
            expect(goalInfo.kind).toBe("GoalType");
          }
        }
      } finally {
        agda.close();
      }
    }, 30000);

    it("goal with no variables in scope has empty context entries", async () => {
      const agda = await spawnAgda(binaryPath);
      try {
        const loadCmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_load ${haskellStringQuote(fixturePath)} [])`;
        const loadResponses = await agda.sendCommand(loadCmd);

        const goalIds = findInteractionPoints(loadResponses);
        // Goal 0 is `x = {!!}` — no variables in context
        const goalId = goalIds[0];

        const cmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_goal_type_context AsIs ${goalId} noRange "")`;
        const responses = await agda.sendCommand(cmd);
        const info = findDisplayInfo(responses);

        expect(info).toBeDefined();
        expect(info!.kind).toBe("GoalSpecific");

        if (info!.kind === "GoalSpecific") {
          const goalInfo = info!.goalInfo;
          expect(goalInfo.kind).toBe("GoalType");
          if (goalInfo.kind === "GoalType") {
            expect(goalInfo.type).toContain("ℕ");
            expect(goalInfo.entries).toHaveLength(0);

            // GoalType has the expected auxiliary fields
            expect(goalInfo.typeAux).toBeDefined();
            expect(goalInfo.typeAux.kind).toBe("GoalOnly");
            expect(Array.isArray(goalInfo.boundary)).toBe(true);
            expect(Array.isArray(goalInfo.outputForms)).toBe(true);
            expect(typeof goalInfo.rewrite).toBe("string");
          }
        }
      } finally {
        agda.close();
      }
    }, 30000);

    it("goal with variable in scope has non-empty context entries with correct structure", async () => {
      const agda = await spawnAgda(binaryPath);
      try {
        const loadCmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_load ${haskellStringQuote(fixturePath)} [])`;
        const loadResponses = await agda.sendCommand(loadCmd);

        const goalIds = findInteractionPoints(loadResponses);
        // Goal 1 is `y n = {!!}` — has `n : ℕ` in context
        const goalId = goalIds[1];

        const cmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_goal_type_context AsIs ${goalId} noRange "")`;
        const responses = await agda.sendCommand(cmd);
        const info = findDisplayInfo(responses);

        expect(info).toBeDefined();
        expect(info!.kind).toBe("GoalSpecific");

        if (info!.kind === "GoalSpecific") {
          const goalInfo = info!.goalInfo;
          expect(goalInfo.kind).toBe("GoalType");
          if (goalInfo.kind === "GoalType") {
            // Goal type should mention ℕ
            expect(goalInfo.type).toContain("ℕ");

            // Context should have at least one entry for `n`
            expect(goalInfo.entries.length).toBeGreaterThan(0);

            const nEntry = goalInfo.entries.find(
              (e) => e.originalName === "n" || e.reifiedName === "n",
            );
            expect(nEntry, "Expected context entry for variable 'n'").toBeDefined();

            // Verify ResponseContextEntry structure
            expect(typeof nEntry!.originalName).toBe("string");
            expect(typeof nEntry!.reifiedName).toBe("string");
            expect(typeof nEntry!.binding).toBe("string");
            expect(typeof nEntry!.inScope).toBe("boolean");

            // n should be in scope and have type ℕ
            expect(nEntry!.inScope).toBe(true);
            expect(nEntry!.binding).toContain("ℕ");
          }
        }
      } finally {
        agda.close();
      }
    }, 30000);

    it("AllGoalsWarnings response from load contains visible goals", async () => {
      const agda = await spawnAgda(binaryPath);
      try {
        const loadCmd = `IOTCM ${haskellStringQuote(fixturePath)} NonInteractive Indirect (Cmd_load ${haskellStringQuote(fixturePath)} [])`;
        const loadResponses = await agda.sendCommand(loadCmd);

        const info = findDisplayInfo(loadResponses);
        expect(info).toBeDefined();
        expect(info!.kind).toBe("AllGoalsWarnings");

        if (info!.kind === "AllGoalsWarnings") {
          expect(info!.visibleGoals.length).toBe(2);

          // Both goals should have type ℕ (or ℕ → ℕ)
          for (const goal of info!.visibleGoals) {
            expect(goal.kind).toBe("OfType");
            if (goal.kind === "OfType") {
              expect(goal.type).toContain("ℕ");
            }
          }

          // AllGoalsWarnings should NOT have context entries
          // (context is only in GoalSpecific responses)
          expect("entries" in info!).toBe(false);
        }
      } finally {
        agda.close();
      }
    }, 30000);
  });
}
