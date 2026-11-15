/**
 * profiles/production-verdicts.ts: the production VerdictSources for profiles/verdicts.ts verdict()
 * (TRDD-SZ7TO9FW plan W1, design/specs/profile-contract.md section 4.1).
 *
 * WHY a separate module: verdicts.ts takes its readers and the current dataset hashes injected, so its tests run on
 * temp dirs. The hash code lives in heavy benchmark modules; this file is the one place that computes the three
 * current hashes the way their benchmarks write them, so a verdict can never judge a row under a different hash than
 * the one it was recorded with (an unknown hash would read every model as untested).
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { ensureLedgersBackfilled } from "../benchmark/backfill-ledgers.js";
import { hqScanQualityHash } from "../benchmark/free-fitness-ledger.js";
import { datasetFingerprint } from "../benchmark/scan-folder/dataset.js";
import { datasetHashFor } from "../benchmark/text-tools/index.js";
import { getConfigDir, loadSettings, scoutAccuracyTargetBytes, scoutAccuracyThreshold } from "../config.js";
import { scoutAccuracyHash } from "../mass_scouting/scout-accuracy-ledger.js";
import { fileSources, type CurrentHashes, type VerdictSources } from "./verdicts.js";

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir); // a dir that does not exist yet has no symlinks to resolve
  }
}

/**
 * The readers and current hashes verdict() needs, computed once and frozen: a command judges every model against the
 * same hashes for its whole run.
 *
 * configDir must be the active config dir (getConfigDir()): the legacy-row backfill and the settings that fix the
 * scout hash both read the active dir, so a different configDir would judge one dir with another dir's hashes. It throws
 * instead of guessing.
 *
 * Before any ledger is read, the zero-call legacy backfill runs (once per process per config dir, the same guard the
 * validated.ts send gate uses): a legacy deterministic row gets its qualityPass from its own score, so it gives a
 * verdict here and at the send gate alike.
 */
export function productionVerdictReader(configDir: string, nowMs: number = Date.now()): VerdictSources {
  const active = getConfigDir();
  if (canonical(configDir) !== canonical(active)) {
    throw new Error(`productionVerdictReader: config dir ${configDir} is not the active config dir ${active}`);
  }
  ensureLedgersBackfilled();

  // The scout hash is mass_scouting/cli.ts's own expression: the gate reads the settings' threshold and target bytes.
  const settings = loadSettings();
  const scout = scoutAccuracyHash(scoutAccuracyThreshold(settings), scoutAccuracyTargetBytes(settings));

  // The hq hash binds the scan-folder fixture corpus. An uncomputable fingerprint (fixtures missing) is no evidence of
  // fitness: undefined, which verdicts.ts reads as untested (benchmark/free-fitness-ledger.ts freeFitnessUnlocked rule).
  let hqScanQuality: string | undefined;
  try {
    hqScanQuality = hqScanQualityHash(datasetFingerprint());
  } catch {
    hqScanQuality = undefined;
  }

  const text = Object.freeze({
    summarize: datasetHashFor("summarize"),
    topics: datasetHashFor("topics"),
    sem_deduplicate: datasetHashFor("sem_deduplicate"),
    describe: datasetHashFor("describe"),
  });
  const currentHash: CurrentHashes = Object.freeze({ scout, hqScanQuality, textTool: (kind: keyof typeof text) => text[kind] });
  return Object.freeze(fileSources(configDir, currentHash, nowMs));
}
