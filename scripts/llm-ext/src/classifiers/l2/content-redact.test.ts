import { describe, expect, it } from "vitest";
import { redactSecrets as pipelineRedact } from "../../scan-pipeline.js";
import { redactSecrets as intakeRedact } from "../../security_scan/intake.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../../security_scan/intake.js";
import { redactContent } from "./content-redact.js";
import { InputError as InputErrorFromModule } from "./input-error.js";
import { InputError, collectInputs, readForJev } from "./inputs.js";

// Secret shapes are built in pieces so no scanner flags this file. Each fixture: the literal secret and the text around it.
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const GHP = "ghp_" + "a1B2c3D4e5".repeat(3) + "a1B2c3";
const SK = "sk-" + "abcdefghij0123456789ABCD";
const JWT = "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0In0." + "dBjftJeZ4CVPmB92K27uhbUJ";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
const FIXTURES: Array<[string, string, string]> = [
  ["aws key", `region = x\nkey: ${AWS}\n`, AWS],
  ["github pat", `token ${GHP} used`, GHP],
  ["plain sk key", `const k = "${SK}";`, SK],
  ["bearer header", `Authorization: Bearer ${"abcdEFGH1234".repeat(2)}`, "abcdEFGH1234abcdEFGH1234"],
  ["jwt", `cookie=${JWT}`, JWT],
  ["env assignment", "\n\n  STRIPE_SECRET_KEY=supersecretvalue99\n", "supersecretvalue99"],
  ["lowercase assignment", `password = "hunter2hunter2"`, "hunter2hunter2"],
  ["connection string", "db: postgres://admin:s3cretpw@db.internal/x", "s3cretpw"],
  ["pem block", `x\n${PEM}\ny`, "MIIEowIBAAKCAQEA"],
];

describe("shared fixture set through both existing redactSecrets implementations", () => {
  for (const [name, text, secret] of FIXTURES) {
    it(`the adopted one (security_scan/intake) removes the ${name} and catches at least what scan-pipeline catches`, () => {
      const adopted = intakeRedact(text);
      const other = pipelineRedact(text);
      expect(adopted.redacted).not.toContain(secret);
      expect(adopted.count).toBeGreaterThanOrEqual(other.count);
      if (other.count > 0) expect(other.redacted).not.toContain(secret);
    });
  }
  it("scan-pipeline misses at least one fixture that intake catches (why intake is the adopted one)", () => {
    const missed = FIXTURES.filter(([, text, secret]) => pipelineRedact(text).redacted.includes(secret));
    expect(missed.length).toBeGreaterThan(0);
  });
});

describe("redactContent (E37)", () => {
  it("redacts a secret inside file content and warns with the file label and the count", () => {
    const r = redactContent(`a\nkey: ${AWS}\nkey2: ${GHP}\n`, "src/app.ts");
    expect(r.text).not.toContain(AWS);
    expect(r.text).not.toContain(GHP);
    expect(r.warning).toBe("src/app.ts: 2 secrets redacted before send");
  });
  it("says 1 secret in the singular", () => {
    expect(redactContent(AWS, "f").warning).toBe("f: 1 secret redacted before send");
  });
  it("returns clean text unchanged and no warning", () => {
    const r = redactContent("const a = 1;\n", "f");
    expect(r).toEqual({ text: "const a = 1;\n" });
  });
});

describe("inputs redact before send (E37)", () => {
  const dir = mkdtempSync(join("/tmp", "l207-")) // /tmp, not os.tmpdir(): sanitizeInputPath only allows cwd, HOME and /tmp;
  const file = join(dir, "cfg.ts");
  writeFileSync(file, `line1\nkey: ${AWS}\n${PEM}\nend\n`);

  it("readForJev returns redacted text and a warning with the count", async () => {
    const s = await readForJev(file, { kind: "whole" });
    expect(s.text).not.toContain(AWS);
    expect(s.text).not.toContain("MIIEowIBAAKCAQEA");
    expect(s.warnings).toContain(`${file}: 2 secrets redacted before send`);
  });
  it("collectInputs in --lines mode redacts a multi-line PEM block before the split", async () => {
    const c = await collectInputs([file], { lines: true });
    expect(c.items.map((i) => i.text).join("\n")).not.toContain("MIIEowIBAAKCAQEA");
    expect(c.warnings.some((w) => w.endsWith("2 secrets redacted before send"))).toBe(true);
  });
  it("collectInputs redacts stdin", async () => {
    const c = await collectInputs(["-"], { stdin: Buffer.from(`k=${AWS}`) });
    expect(c.items[0]!.text).not.toContain(AWS);
    expect(c.warnings).toContain("stdin: 1 secret redacted before send");
  });
});

describe("review fixes: line numbers, slices, fail-closed walk", () => {
  const KEYBODY = "MIIEowIBAAKCAQEAxyz";
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${KEYBODY}1\n${KEYBODY}2\n${KEYBODY}3\n-----END RSA PRIVATE KEY-----`;
  // PEM block on lines 3-9? here lines 3..7 (BEGIN, 3 body, END); marker on line 8.
  const body = `l1\nl2\n${pem}\nMARKER\nl9\n`;
  const dir2 = mkdtempSync(join("/tmp", "l207b-"));
  const f2 = join(dir2, "k.txt");
  writeFileSync(f2, body);

  it("a line range that starts inside a PEM block sends no key body", async () => {
    const s = await readForJev(f2, { kind: "lines", from: 5, to: 6 });
    expect(s.text).not.toContain(KEYBODY);
  });
  it("readForJev keeps line numbers: MARKER is still line 8 after the PEM block is redacted", async () => {
    const s = await readForJev(f2, { kind: "lines", from: 8, to: 8 });
    expect(s.text).toBe("MARKER");
    const all = await readForJev(f2, { kind: "whole" });
    expect(all.text.split("\n")[7]).toBe("MARKER");
    expect(all.totalLines).toBe(9);
  });
  it("collectInputs with lines keeps the line number of the marker after the block", async () => {
    const c = await collectInputs([f2], { lines: true });
    expect(c.items.some((i) => i.id.endsWith(":8") && i.text === "MARKER")).toBe(true);
  });
  it("an ENV_SECRET match, which swallows its leading newline, does not shift later lines either", () => {
    const r = redactContent(`a\nSTRIPE_SECRET_KEY=supersecretvalue99\nb`, "f");
    expect(r.text.split("\n").length).toBe(3);
    expect(r.text.split("\n")[2]).toBe("b");
  });
  it("a BEGIN line that is not a redactable key does not swallow the lines after it", () => {
    const t = `-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\nk=${AWS}\nz`;
    const r = redactContent(t, "f");
    expect(r.text.split("\n").length).toBe(5);
    expect(r.text).toContain("abc");
  });
  it("one file whose redaction fails goes to skipped and the walk continues", async () => {
    const d = mkdtempSync(join("/tmp", "l207c-"));
    writeFileSync(join(d, "a.txt"), `k=${AWS}`);
    writeFileSync(join(d, "b.txt"), "plain");
    const c = await collectInputs([d], { redactBudgetMs: -1 });
    expect(c.items).toEqual([]);
    expect(c.skipped.map((x) => x.reason)).toEqual([expect.stringContaining("redaction"), expect.stringContaining("redaction")]);
  });
  it("a named file, stdin and --items still refuse when redaction fails", async () => {
    await expect(readForJev(f2, { kind: "whole" }, { redactBudgetMs: -1 })).rejects.toThrow(InputError);
    await expect(collectInputs(["-"], { stdin: Buffer.from("x"), redactBudgetMs: -1 })).rejects.toThrow(InputError);
    const items = join(dir2, "items.txt");
    writeFileSync(items, "one\n");
    await expect(collectInputs([], { items, redactBudgetMs: -1 })).rejects.toThrow(InputError);
  });
  it("InputError is one class, importable from its own module and from inputs.ts", () => {
    expect(InputErrorFromModule).toBe(InputError);
  });
});

describe("newline-preserving redaction", () => {
  const BODY = "MIIEowIBAAKCAQEAxyz";
  const PEM2 = `-----BEGIN RSA PRIVATE KEY-----\n${BODY}1\n${BODY}2\n-----END RSA PRIVATE KEY-----`;
  it("(a) a multi-line PEM block keeps the line count and the marker line after it keeps its number", () => {
    const t = `l1\n${PEM2}\nMARKER\nl7`;
    const r = redactContent(t, "f").text.split("\n");
    expect(r.length).toBe(t.split("\n").length);
    expect(r[5]).toBe("MARKER");
    expect(r[1]).toBe("[REDACTED:PEM_BLOCK]");
  });
  it("(b) a secret pattern spanning two lines (Bearer, whitespace then token on the next line) is redacted even when the file has a PEM block", () => {
    const tok = "abcdEFGH1234".repeat(2);
    const t = `${PEM2}\nAuthorization: Bearer\n${tok}\nMARKER`;
    const r = redactContent(t, "f").text;
    expect(r).not.toContain(tok);
    expect(r.split("\n").length).toBe(t.split("\n").length);
    expect(r.split("\n")[6]).toBe("MARKER");
  });
  it("(c) a match that begins with a newline leaves the previous line untouched and the line count unchanged", () => {
    const r = redactContent("prev line\nSTRIPE_SECRET_KEY=supersecretvalue99\nnext", "f").text.split("\n");
    expect(r).toEqual(["prev line", "[REDACTED:ENV_SECRET]", "next"]);
  });
  it("(d) redactSecrets without the option returns exactly what it returned before", () => {
    expect(redactSecrets(`a\n${PEM2}\nz`).redacted).toBe("a\n[REDACTED:PEM_BLOCK]\nz");
    expect(redactSecrets("a\nSTRIPE_SECRET_KEY=supersecretvalue99\nb")).toEqual({ redacted: "a[REDACTED:ENV_SECRET]\nb", count: 1 });
  });
});
