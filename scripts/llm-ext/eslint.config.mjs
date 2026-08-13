// ESLint flat config — lint-as-a-gate for publish.py
// Uses typescript-eslint recommended rules + a minimal set of errors.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      // Benchmark fixtures are test INPUT, not project source: deliberately
      // odd code the search-existing benchmark scans. Linting them reports
      // noise, and "fixing" a fixture to satisfy a rule changes the benchmark's
      // input and so its results.
      "benchmark-fixtures/**",
      "*.js",
      "*.mjs",
      "*.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        ReadableStreamDefaultReader: "readonly",
        URL: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
      },
    },
    rules: {
      // Errors: real bugs, not style
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off", // too many legit uses in LLM response parsing
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "prefer-const": "error",
      // Disable overly strict rules
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  // ── Guardrails for two bug classes that each shipped TWICE ────────────────
  //
  // Both are here because prose could not hold the line: the rule was written
  // in a header comment, the comment was read, and the next module did it wrong
  // anyway. A lint gate is checked by publish.py; a comment is checked by
  // whoever happens to look.
  {
    files: ["src/**/*.ts"],
    // Tests are exempt: one asserts that the DEFAULT really does land in
    // ~/.llm-externalizer, which is the invariant, not a violation of it.
    ignores: ["src/config.ts", "**/*.test.ts"],
    rules: {
      // The config directory is built in exactly ONE place: config.getConfigDir().
      // Re-deriving it as join(homedir(), ".llm-externalizer") does two damaging
      // things at once — it ignores LLM_EXT_CONFIG_DIR (so an "isolated" run
      // reads and writes the user's REAL config), and it skips getConfigDir()'s
      // symlink resolution of the deepest existing ancestor, which is the control
      // that stops mkdirSync(recursive) being walked outside the allowlist by a
      // planted symlink. That is a security control, not a preference. It was
      // fixed in free-pool-auto-bench.ts and immediately found again, unfixed, in
      // cluster/preflight_benchmark.ts.
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value='.llm-externalizer']",
          message:
            "Do not build the config dir here — call getConfigDir() from config.js. " +
            "A bare join(homedir(), '.llm-externalizer') ignores LLM_EXT_CONFIG_DIR and " +
            "bypasses the symlink-escape guard.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    // Tests are exempt: launcher-boot.test.ts spawns the real launcher, which is
    // the only way to catch an entry-guard regression the unit tests cannot see.
    ignores: ["src/bench-spawn.ts", "**/*.test.ts"],
    rules: {
      // Detached children are spawned in exactly ONE place: bench-spawn.ts.
      // A hand-rolled `spawn(..., {detached: true})` has to get four separate
      // things right — close the parent's dup'd log fd, attach an 'error'
      // listener (an unhandled one is re-thrown as an uncaught exception from a
      // tick no try/catch can reach), unref, and roll back the lock on failure.
      // Two copies existed and both leaked the fd. spawnSync/execFile/execFileSync
      // are unaffected: they are synchronous and own no detached child.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              importNames: ["spawn"],
              message:
                "Use spawnDetachedBench() from bench-spawn.js — it owns the lock claim, " +
                "the log fd lifetime, the 'error' listener, and the rollback.",
            },
          ],
        },
      ],
    },
  },
];
