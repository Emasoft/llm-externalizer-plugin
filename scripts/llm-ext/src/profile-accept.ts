// PT-03 (TRDD-B9FWID59): the runtime check of each command's `acceptedProfileTypes`
// (the table lives once in tools/definitions.ts). Pure so it is testable without
// spawning the CLI (cli/main.ts runs main() at import and cannot be imported).
// Lives outside config.ts because config.ts is owned by another card in flight.
import { DEFAULT_PROFILE_NAME, PROFILE_TYPES, builtinProfileType, inferProfileType, type Profile, type ProfileType, type Settings } from "./config.js";

/** The types a text command (and `active:`) may use. */
export const TEXT_PROFILE_TYPES: readonly ProfileType[] = ["local", "free", "paid"];

/** Marker of a command that makes no model call: it accepts every type. */
export const ANY_PROFILE_TYPE: readonly ProfileType[] = PROFILE_TYPES;

/** One-line form for --help and error messages. */
export function describeAcceptedTypes(accepted: readonly ProfileType[]): string {
  return accepted.length === PROFILE_TYPES.length ? "any" : accepted.join(", ");
}

// A profile that does not exist yet is either a builtin the CLI auto-stubs (type known by name) or a dangling name that overrideActiveProfile already reported.
function typeOfProfile(name: string, profiles: Readonly<Record<string, Profile>> | undefined): ProfileType | undefined {
  const profile = profiles?.[name];
  return profile !== undefined ? inferProfileType(name, profile) : builtinProfileType(name);
}

/**
 * Why this invocation must be refused, or undefined when it may run.
 * `command` is the form the user typed. `viewsSettings` marks the commands that
 * must keep working with a broken `active:` so the user can see and fix it.
 * `settings` MUST be the snapshot taken BEFORE overrideActiveProfile: that call
 * overwrites `active` with the selected name (index.ts applyNewSettings), which
 * would hide a wrong `active:` on disk.
 */
function refusalOrThrow(a: {
  command: string;
  accepted: readonly ProfileType[];
  viewsSettings: boolean;
  profileFlag: string | undefined;
  settings: Pick<Settings, "active" | "profiles">;
}): string | undefined {
  const { command, accepted, settings } = a;
  // WHY first and for every command: `active:` is a load-time contract (E81i); checking it only for commands that read it would let a wrong key sit unnoticed until the day it is used.
  if (!a.viewsSettings && settings.active !== undefined) {
    const activeType = typeOfProfile(settings.active, settings.profiles);
    if (activeType !== undefined && !TEXT_PROFILE_TYPES.includes(activeType)) {
      return `settings.yaml 'active:' names profile '${settings.active}' of type '${activeType}'; 'active:' must name a ${TEXT_PROFILE_TYPES.join(", ")} profile.`;
    }
  }
  // WHY return before inferring a type: a command that accepts every type can never refuse, and inferring would throw on a malformed profile of a settings viewer, which must stay usable to fix it.
  if (accepted === ANY_PROFILE_TYPE) return undefined;
  // WHY only --profile for commands that accept no text type: a scouting-only or classifier-only command takes its default from `scouting` / `active_classifier:` (PT-05, classify cards), never from `active:`, so `active:` would wrongly refuse it.
  const takesActive = accepted.some((t) => TEXT_PROFILE_TYPES.includes(t));
  const name = a.profileFlag ?? (takesActive ? (settings.active ?? DEFAULT_PROFILE_NAME) : undefined);
  if (name === undefined) return undefined;
  const type = typeOfProfile(name, settings.profiles);
  if (type === undefined || accepted.includes(type)) return undefined;
  return `${command} does not accept profile '${name}' (type '${type}'); accepted profile types: ${describeAcceptedTypes(accepted)}.`;
}

type SelectionInput = Parameters<typeof refusalOrThrow>[0];

// WHY catch: inferProfileType throws the loader's own named profile-type message for a malformed profile; as refusal text the user sees that message and not a raw exception.
export function profileSelectionRefusal(a: SelectionInput): string | undefined {
  try {
    return refusalOrThrow(a);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
