// The master paid-spend switch (Settings.allow_paid_models), isolated in a LEAF
// module with ZERO local imports.
//
// WHY its own file: config.ts imports model-qualification/registry.ts, which
// imports benchmark/discover.ts. discover.ts needs to read this switch at its
// paid-benchmark chokepoint (assertPaidBenchmarkAllowed). If discover.ts imported
// it from config.ts, that would close the cycle config → registry → discover →
// config, and the cycle's init order left TOOL_MODEL_REGISTRY's criteria
// undefined (a real regression caught by registry.test.ts). A leaf both sides can
// import breaks the loop. config.ts re-exports these so its own consumers
// (index.ts / cli.ts / benchmark/index.ts) keep importing from config unchanged.
//
// DEFAULT false — "only free models are viable, everything free by default"
// (USER directive). A process that never sets it (and every test) is free-safe:
// the safe posture is the one you get by doing nothing. Same single-writer
// discipline as config.ts's _activeFreeOnly — index.ts / the CLIs call
// setAllowPaidModels() the instant they load settings.

let _allowPaidModels = false;

/** Record the master paid-spend switch. Call wherever settings load/reload. */
export function setAllowPaidModels(allow: boolean): void {
  _allowPaidModels = allow;
}

/** True iff paid spend is permitted at all (Settings.allow_paid_models). When
 *  false, remote profiles are forced to free at boot and paid benchmarks refuse. */
export function getAllowPaidModels(): boolean {
  return _allowPaidModels;
}
