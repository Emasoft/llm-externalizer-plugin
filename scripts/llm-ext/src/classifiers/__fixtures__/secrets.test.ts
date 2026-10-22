import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RecordedReply } from "../l0/test-fetch.js";

const DIR = dirname(fileURLToPath(import.meta.url));

// WHY: the fixtures are committed to a public repo; each pattern is something that identifies the account or a request (P-03, plan §18).
const LEAKS: [string, RegExp][] = [
  ["api key prefix", /sk-[A-Za-z0-9]/],
  ["user id", /user_[A-Za-z0-9]{6,}/],
  ["generation id", /gen-[A-Za-z0-9]/],
  ["account field", /creator_user_id|"user_id"|workspace_id|organization_id|usage_(daily|weekly|monthly)|limit_remaining|limit_reset|byok_usage|free_model_daily_requests/],
  ["identifying header or cookie", /set-cookie|__cf_bm|cf-ray|request-id|x-generation-id|x-provider-name|cf-connecting-ip|cf-ipcountry|x-forwarded-for/i],
];

export function findLeaks(text: string): string[] {
  const found = LEAKS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const envKey = process.env.OPENROUTER_API_KEY;
  // WHY: the real key, when the environment has one, must never appear verbatim even if no prefix pattern matches.
  if (envKey && envKey.length > 8 && text.includes(envKey)) found.push("OPENROUTER_API_KEY value");
  return found;
}

function fixtureFiles(): string[] {
  return ["p01", "p02"].flatMap((d) => readdirSync(join(DIR, d)).map((f) => join(DIR, d, f)));
}

describe("classifier fixtures carry no account or request identity", () => {
  it("the scanner flags a key prefix, a user id, a generation id, a cookie and an account field", () => {
    expect(findLeaks("sk-or-v1-abc")).toContain("api key prefix");
    expect(findLeaks("user_2g2eD6sJXkPd")).toContain("user id");
    expect(findLeaks('{"id":"gen-dec-1"}')).toContain("generation id");
    expect(findLeaks("Set-Cookie: __cf_bm=x")).toContain("identifying header or cookie");
    expect(findLeaks('{"usage_daily":3}')).toContain("account field");
  });

  it("there are fixtures, each in the RecordedReply shape, and none matches a leak pattern", () => {
    const files = fixtureFiles();
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const rec = JSON.parse(text) as RecordedReply;
      expect(Object.keys(rec).sort(), f).toEqual(["body", "headers", "status"]);
      expect(typeof rec.status, f).toBe("number");
      expect(typeof rec.body, f).toBe("string");
      expect(findLeaks(text), f).toEqual([]);
    }
  });

  it("the /api/v1/key fixture keeps no label, usage or limit figure", () => {
    const rec = JSON.parse(readFileSync(join(DIR, "p02", "key.json"), "utf8")) as RecordedReply;
    expect(JSON.parse(rec.body)).toEqual({ data: { is_management_key: false, is_provisioning_key: false } });
  });
});
