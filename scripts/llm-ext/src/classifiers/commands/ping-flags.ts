// C4-07 (TRDD-MVT4DCHS): the declaration of `classify ping`, a leaf module with NO imports.
// WHY a leaf: tools/definitions.ts and cli/launcher.ts load at every CLI start and must not drag the runner chain (transport, fan-out) in just to list this command; the tool schema, `--help` and the argv parser (ping.ts) all read this one list, so they cannot drift.
// WHY the tool name has no `classify_` prefix: that prefix means "a registered decision spec" (catalog/index.ts unregisteredClassifyTools), and ping is not a decision.
export const PING_TOOL_NAME = "classifier_ping";

export const PING_DESCRIPTION =
  "Check the classifier key and the decisions service: a free key check (GET /api/v1/key, which reports the key spend and limit, never the key), then one tiny paid question to the profile model. Exits non-zero when either step fails. It is a round-trip check: the answer is printed with the side it is expected on (above 0.5), and an answer on the other side prints a warning on stderr but still exits 0. The key is read from the environment variable named by the profile api_key and is never printed. The question is recorded in the usage history; --max-budget does not apply to it (ping takes no budget flag, and one question costs a fraction of a cent).";

export interface PingFlag {
  flag: string;
  property: string;
  type: "boolean";
  help: string;
}

export const PING_FLAGS: readonly PingFlag[] = [
  { flag: "--no-call", property: "no_call", type: "boolean", help: "Only the free key check; send no question (nothing is billed)." },
];
