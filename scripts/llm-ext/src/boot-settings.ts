// Boot-time settings migrations and the re-read that follows them (extracted from index.ts's boot IIFE so a test can call it; importing index.ts boots the whole engine).

import { type Settings, getSettingsPath, loadSettings } from "./config.js";
import { migrateProfileSections, migrateSettingsTo141 } from "./benchmark/pick.js";
import {
  getProfileMigrationStamp,
  stampProfileMigrationDone,
  isMigrationStepApplied,
  markMigrationStepApplied,
} from "./default-profiles-state.js";

/**
 * Call after ensureSettingsExist() (it guarantees the file exists and parses). Runs the migrations and returns settings.yaml as it is afterwards.
 *
 * P6c-a item 3 (addendum K): the ONE-TIME pre-14.0.0 migration runs HERE —
 * at boot, before validateSettings and therefore long before the
 * dispatch maintainer. Order is load-bearing twice over: a section it
 * ADOPTS must already carry the generated marker when the maintainer first
 * looks at it (otherwise the maintainer backs the same section up a second
 * time), and validateSettings' reserved-name refusal must not fire on the
 * very file the migration is about to fix.
 *
 * The migrations themselves never throw (see migrateProfileSections); each is a no-op after its first
 * successful pass. Throws when settings.yaml cannot be read again after them (deleted or no longer parses). Costs a state-file read and one settings.yaml re-read per boot.
 */
export function loadSettingsAfterMigrations(): Settings {
  migrateProfileSections(getSettingsPath(), {
    notify: (msg) => process.stderr.write(`${msg}\n`),
    readStamp: getProfileMigrationStamp,
    writeStamp: stampProfileMigrationDone,
  });
  // D0 (TRDD-AL8GIZYA): the 14.1.0 migration list runs right after the
  // pre-14.0.0 one, for the same two reasons — a step must see MARKED
  // dynamic sections (writeDynamicProfileSection's per-key generated-key
  // merge assumes that), and a settings-level refusal it fixes (E-D3) must
  // not fire on the very file this migration is about to correct.
  migrateSettingsTo141(getSettingsPath(), {
    notify: (msg) => process.stderr.write(`${msg}\n`),
    isApplied: isMigrationStepApplied,
    markApplied: markMigrationStepApplied,
  });
  // WHY no early return when nothing was recorded (TRDD-VBAJX5A1): an earlier version returned the copy read before the
  // migrations when the migration pass recorded nothing, assuming "nothing recorded" means the file did not change. That
  // is false when another process wrote settings.yaml between the first read and now: the two steps not gated on the
  // record (scouting-section-marked, profile-type-written) report only their OWN writes, so they report nothing when the
  // other process already did the work, and the stale pre-migration copy (untyped profiles, unmarked scouting) was
  // returned and refused at validation. So always re-read, picking up a migration here (it may have deleted, adopted,
  // regenerated or rewritten a section) and another process alike.
  const reread = loadSettings();
  // WHY throw on null and not fall back to the copy read before the migrations: null means the file vanished or stopped
  // parsing after ensureSettingsExist read it; returning that older copy would hand back the stale settings this function
  // exists to avoid, and ensureSettingsExist already throws on a null read for the same reason. The boot IIFE's catch in
  // index.ts turns the throw into settingsError (TRDD-VBAJX5A1).
  if (reread === null) {
    throw new Error(`settings.yaml could not be read again after the boot migrations (${getSettingsPath()}): it was deleted or no longer parses`);
  }
  return reread;
}
