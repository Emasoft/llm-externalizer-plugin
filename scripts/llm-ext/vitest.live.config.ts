import base from "./vitest.config";

// The paid live suites. WHY a separate config: the base config has an explicit include list with no live file, so
// `vitest run src/live.test.ts` there matched nothing and `npm run test:live` ran nothing. This REPLACES test.include
// (a mergeConfig would append to it); every suite still gates itself on LIVE_TESTS=1 + OPENROUTER_API_KEY.
export default {
  ...base,
  test: {
    ...base.test,
    include: ["src/live.test.ts", "src/live-extended.test.ts", "src/live-websearch.test.ts", "src/live-classify.test.ts"],
  },
};
