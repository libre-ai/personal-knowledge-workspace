// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The passes of AT-01 (PROTOCOL.md section 10.5). A pass is a fresh copy of the
// corpus and its reference snapshot; a first launch opens and closes every file
// without edit, then exits, and the snapshot is compared to the reference; a
// second launch, on the same copy, edits one paragraph of each editable file,
// then exits, and each file is compared to its bytes before that second launch.
// A pass gives the counts of both lines of AT-01 and is completed only when both
// launches are; an interrupted pass is recorded and redone from a fresh copy
// (section 5). The launches themselves are steps, so that the procedure is
// tested without the shell.

import { compareSnapshots, snapshotDirectory } from "../oracle";
import { type Interruption, type Streak, untilCompleted } from "./attempts";
import { type EditPlan, editCounts, editPlan, readFiles } from "./corpus";
import type { EditPass, RoundTripPass } from "./evaluate";

export interface At01Steps {
  freshCopy(): { vault: string; dispose(): void };
  /** Opens and closes `paths` in order, without edit, then exits. */
  roundTripLaunch(vault: string, paths: string[], unit: string): Promise<void>;
  /** Edits the planned paragraph of each editable file, in order, then exits. */
  editLaunch(vault: string, plan: EditPlan, unit: string): Promise<void>;
}

export interface At01Series {
  roundTrip: RoundTripPass[];
  edit: EditPass[];
  /** Counted on the corpus, before the series. */
  editableFiles: number;
}

/**
 * `withEdit` false makes the round trip alone: a trial of the round-trip line
 * (`--only at-01-round-trip`), which is never a report.
 */
export async function at01Series(
  passes: number,
  withEdit: boolean,
  steps: At01Steps,
  interruptions: Interruption[],
  streak: Streak,
): Promise<At01Series> {
  const series: At01Series = { roundTrip: [], edit: [], editableFiles: 0 };
  for (let pass = 0; pass < passes; pass += 1) {
    const unit = `at-01 pass ${pass}`;
    const completed = await untilCompleted(
      unit,
      async () => {
        const { vault, dispose } = steps.freshCopy();
        try {
          const reference = snapshotDirectory(vault);
          const plan = editPlan(readFiles(vault));
          await steps.roundTripLaunch(vault, [...reference.keys()], unit);
          const { examined, identical, changed, missing, added } = compareSnapshots(
            reference,
            snapshotDirectory(vault),
          );
          const roundTrip: RoundTripPass = { examined, identical, changed, missing, added };
          if (!withEdit) return { roundTrip, plan, edit: null };
          const beforeEdit = readFiles(vault);
          await steps.editLaunch(vault, plan, unit);
          return { roundTrip, plan, edit: editCounts(beforeEdit, readFiles(vault), plan) };
        } finally {
          dispose();
        }
      },
      interruptions,
      streak,
    );
    series.roundTrip.push(completed.roundTrip);
    series.editableFiles = completed.plan.items.length;
    if (completed.edit !== null) series.edit.push(completed.edit);
    console.log(
      `series: ${unit}: round trip ${completed.roundTrip.identical}/${completed.roundTrip.examined} identical` +
        (completed.edit === null ? "" : `, edit ${JSON.stringify(completed.edit)}`),
    );
  }
  return series;
}
