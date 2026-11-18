/**
 * The ONE definition of the secret-detection regexes used before text leaves the machine or is logged.
 *
 * WHY one module (TRDD-GBWVXEF6): the same patterns lived twice, in src/scan-pipeline.ts and src/security_scan/intake.ts, with a
 * "keep the PEM_BLOCK and ENV_SECRET lines byte-identical by hand" comment. They had already drifted once (TRDD-G49XPDNI had to fix both
 * copies). Each regex is now defined once here and the two consumers compose their arrays from the same objects.
 *
 * WHY two arrays, not one: the two consumers deliberately DIFFER and this module keeps that difference exactly as it was (no behaviour
 * change). INTAKE_SECRET_PATTERNS adds sk-, AIza, JWT, CONN_STRING and SECRET_ASSIGNMENT on top of the shared set; SCAN_PIPELINE_SECRET_PATTERNS
 * does not. Widening scan-pipeline to the intake superset would switch on SECRET_ASSIGNMENT, CONN_STRING and JWT in the abort-on-detect guard of
 * the chat and scan tools (benign `token: abcd` hits): a product decision, not part of this merge. classifiers/l2/content-redact.test.ts pins
 * the divergence. ORDER matters (each pattern is applied in turn to the output of the previous one), so each array keeps its original order.
 *
 * WHY the regex objects are shared between the two arrays: every consumer sets `lastIndex = 0` before using a /g pattern, and `match` / `replace`
 * reset it, so sharing one RegExp instance carries no state between uses.
 *
 * SECURITY (F1, F3 — aegis 2026-05-23): every pattern here runs on attacker-controlled bytes before egress, so each one MUST be authored
 * backtracking-free — bounded quantifiers, line-starts anchored via `[^\S\r\n]*` (never `\s*`, which includes `\n` and re-anchors at every
 * newline → O(n²) ReDoS). Do NOT reintroduce `\s*` spanning newlines in any egress pattern.
 */

export type SecretPattern = [RegExp, string];

const AWS_KEY: SecretPattern = [/AKIA[0-9A-Z]{16}/g, "AWS_KEY"];
const API_KEY_INFIXED: SecretPattern = [/(?:sk|pk)[-_](?:live|test|proj)[-_][A-Za-z0-9]{20,}/g, "API_KEY"];
const GITHUB_PAT_CLASSIC: SecretPattern = [/ghp_[A-Za-z0-9]{36}/g, "GITHUB_PAT"];
const GITHUB_TOKEN: SecretPattern = [/ghr_[A-Za-z0-9]{36}/g, "GITHUB_TOKEN"];
const GITHUB_OAUTH: SecretPattern = [/gho_[A-Za-z0-9]{36}/g, "GITHUB_OAUTH"];
const GITHUB_PAT_FINE: SecretPattern = [/github_pat_[A-Za-z0-9_]{82}/g, "GITHUB_PAT"];
const GITLAB_TOKEN: SecretPattern = [/glpat-[A-Za-z0-9\-_]{20,}/g, "GITLAB_TOKEN"];
const SLACK_TOKEN: SecretPattern = [/xox[bpsar]-[A-Za-z0-9-]+/g, "SLACK_TOKEN"];
const BEARER_TOKEN: SecretPattern = [/Bearer\s+[A-Za-z0-9._\-/+=]{20,}/g, "BEARER_TOKEN"];

// Key-value patterns in env/config files (must have at least 8 chars in the value)
const ENV_SECRET: SecretPattern = [
  // Common env-var-style secret names. Extended in v9.9.0 from a hand-
  // curated list to a hybrid approach: explicit names for the most-common
  // OAuth / vendor key shapes AND a wildcard for any *_KEY / *_TOKEN /
  // *_SECRET / *_PASSWORD. Wildcards intentionally catch JWT_SECRET,
  // LM_API_TOKEN (the plugin's own preset!), STRIPE_SECRET_KEY,
  // SUPABASE_SERVICE_KEY, SLACK_BOT_TOKEN, and similar without needing
  // per-vendor patches.
  // TRDD-G49XPDNI: indent/spacing is `[^\S\r\n]*` (any whitespace except a line break, so VT/FF count), never `\s*`: the old unbounded `\s*` spans newlines and
  // backtracked for more than 120 s on 500 KB (100 KB took 2.4-2.9 s). Newlines are therefore allowed only in bounded places, so cost stays linear:
  // up to THREE newlines before the separator (`API_KEY` newline `= v`) and up to THREE after it (`API_KEY:` newline `  v`, or blank lines before the value).
  // A line break is `\r\n`, `\n` or a bare `\r` (old Mac files; the old `\s*` matched it). Remaining loss vs the old `\s*`: 4+ line breaks on one side of the separator
  // (the only misses in a 500000-string fuzz over a fixed alphabet that includes a bare `\r`; not proven exhaustive).
  // Trade-off (measured): a benign next line is also hidden (`API_KEY =` newline `  process.env.X;`, `API_KEY:` newline `  nested_key: value`); a redactor prefers
  // hiding one extra token to leaking a value. `# comment` and `await getKey();` after `const API_KEY =` are not matched.
  /(?:^|\n)[^\S\r\n]*(?:(?:PASSWORD|PASSWD|SECRET|API_KEY|APIKEY|AUTH|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|SECRET_KEY|ACCESS_KEY|DB_PASSWORD|DATABASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|BITBUCKET_TOKEN|NPM_TOKEN|DOCKER_PASSWORD|HF_TOKEN|HUGGINGFACE_TOKEN|LM_API_TOKEN|VLLM_API_KEY|JWT_SECRET|JWT_PRIVATE_KEY|STRIPE_SECRET_KEY|STRIPE_API_KEY|SUPABASE_SERVICE_KEY|SUPABASE_ANON_KEY|FIREBASE_TOKEN|SLACK_BOT_TOKEN|SLACK_TOKEN|DISCORD_TOKEN|TELEGRAM_BOT_TOKEN|TWILIO_AUTH_TOKEN|SENDGRID_API_KEY|MAILGUN_API_KEY|SENTRY_AUTH_TOKEN|PRIVATE)|[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_APIKEY|_API_KEY|_AUTH))[^\S\r\n]*(?:(?:\r\n?|\n)[^\S\r\n]*){0,3}[=:][^\S\r\n]*(?:(?:\r\n?|\n)[^\S\r\n]*){0,3}['"]?([^\s'"#\n]{8,})/gim,
  "ENV_SECRET",
];

// H7: Multi-line secret blocks (PEM private keys, certificates)
const PEM_BLOCK: SecretPattern = [
  // TRDD-G49XPDNI: the first 16384 body chars are bounded (an RSA-8192 PEM is ~6.4 KB) so each BEGIN costs O(16384); the old lazy `[\s\S]*?`
  // re-scanned to end of input per unterminated BEGIN (20000 headers: 2.7-4.4 s, 200000: > 3 min). A BEGIN with no END inside that window fails
  // TOWARD REDACTION: the second alternative takes the header, 16384 chars, the rest of the base64 run `[A-Za-z0-9+/=\s]*` and an optional END line,
  // so a terminated block of ANY length is redacted through its END and nothing of its body is left. Measured linear (1 MB hostile: <= 8 ms).
  // Unterminated and over 16384 chars: the following base64-like text (letters, digits, +/=, whitespace) is redacted with it (over-redaction accepted).
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE)-----(?:[\s\S]{0,16384}?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE)-----|[\s\S]{0,16384}[A-Za-z0-9+/=\s]*(?:-----END [A-Z0-9 ]+-----)?)/g,
  "PEM_BLOCK",
];

// F3 (intake only): classic OpenAI-style `sk-…` key with no infix (the sk-proj/sk-live shapes are caught by API_KEY_INFIXED; this catches plain
// `sk-<base62>`). Single bounded class after the literal prefix → no backtracking.
const API_KEY_PLAIN: SecretPattern = [/sk-[A-Za-z0-9]{20,}/g, "API_KEY"];

// F3 (intake only): Google API key — fixed 35-char tail, single bounded class.
const GOOGLE_API_KEY: SecretPattern = [/AIza[0-9A-Za-z\-_]{35}/g, "GOOGLE_API_KEY"];

// F3 (intake only): raw JWT (header.payload.signature). Each segment is its own bounded
// class separated by a literal dot — disjoint classes, no backtracking.
// TRDD-G49XPDNI: starts only at a run boundary `(?<![A-Za-z0-9_-])`, so each [A-Za-z0-9_-] run is scanned O(1) times. The old
// unanchored form re-scanned the whole run from every `eyJ` inside it (500000 x "eyJ" did not finish in 120 s; now ~20 ms). The `eyJ`
// may sit anywhere in the first segment, so a glued prefix (`xeyJ...`, `token-eyJ...`) is redacted with it (over-redaction accepted).
// Each segment is atomic via lookahead-capture `(?=(X+))\N` (no backtracking). Every old match is covered by a new match (fuzz, 300000 strings).
const JWT: SecretPattern = [
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*eyJ[A-Za-z0-9_-])(?=([A-Za-z0-9_-]+))\1\.eyJ(?=([A-Za-z0-9_-]+))\2\.(?=([A-Za-z0-9_-]+))\3/g,
  "JWT",
];

// F3 (intake only): connection string with inline credentials (scheme://user:pass@host).
// The `[^:@/\s]+` runs are disjoint from their `:`/`@` delimiters → linear.
const CONN_STRING: SecretPattern = [/:\/\/[^:@/\s]+:[^@/\s]+@/g, "CONN_STRING"];

// F3 (intake only): case-insensitive catch for lowercase / mixed-case secret assignments
// (e.g. `password = "..."`, `token: ...`, `"apikey":"..."`). Matches the
// keyword + its `:`/`=` separator + value. `[ \t]*` keeps it line-local so
// the quantifiers cannot cross newlines → linear.
const SECRET_ASSIGNMENT: SecretPattern = [
  /(?:password|passwd|pwd|token|secret|apikey)["']?[ \t]*[:=][ \t]*['"]?([^\s'"#\n]{4,})/gi,
  "SECRET_ASSIGNMENT",
];

/** Patterns for src/scan-pipeline.ts (scanForSecrets / redactSecrets of the chat and scan tools). Original order kept. */
export const SCAN_PIPELINE_SECRET_PATTERNS: SecretPattern[] = [
  AWS_KEY,
  API_KEY_INFIXED,
  GITHUB_PAT_CLASSIC,
  GITHUB_TOKEN,
  GITHUB_OAUTH,
  GITHUB_PAT_FINE,
  GITLAB_TOKEN,
  SLACK_TOKEN,
  BEARER_TOKEN,
  ENV_SECRET,
  PEM_BLOCK,
];

/** Patterns for src/security_scan/intake.ts (redactSecrets used by egress, model events, usage history and the classifier redactor). Original order kept. */
export const INTAKE_SECRET_PATTERNS: SecretPattern[] = [
  AWS_KEY,
  API_KEY_INFIXED,
  API_KEY_PLAIN,
  GOOGLE_API_KEY,
  GITHUB_PAT_CLASSIC,
  GITHUB_TOKEN,
  GITHUB_OAUTH,
  GITHUB_PAT_FINE,
  GITLAB_TOKEN,
  SLACK_TOKEN,
  BEARER_TOKEN,
  JWT,
  CONN_STRING,
  ENV_SECRET,
  SECRET_ASSIGNMENT,
  PEM_BLOCK,
];
