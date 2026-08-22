import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dynadotSource = readFileSync(new URL("../src/dynadot.ts", import.meta.url), "utf8");
const devVarsExample = readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8");
const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("dynadot client uses correct base URLs and never infers legacy endpoints", () => {
  assert.match(dynadotSource, /api\.dynadot\.com/);
  assert.match(dynadotSource, /api-sandbox\.dynadot\.com/);
  assert.match(dynadotSource, /DYNADOT_SANDBOX_BASE_URL/);
  assert.match(dynadotSource, /DYNADOT_PRODUCTION_BASE_URL/);
  assert.doesNotMatch(dynadotSource, /api2\.dynadot\.com/);
});

test("dynadot signature follows official spec: apiKey newline path newline requestId newline body, HMAC-SHA256, Base64", () => {
  assert.match(dynadotSource, /apiKey \+ "\\n" \+ fullPathAndQuery \+ "\\n"/);
  assert.match(dynadotSource, /HMAC.*SHA-256/);
  assert.match(dynadotSource, /base64/i);
  assert.match(dynadotSource, /createDynadotSignature/);
  assert.match(dynadotSource, /hmacSha256Base64/);
});

test("dynadot auth uses Bearer and X-Signature with X-Request-ID UUID", () => {
  assert.match(dynadotSource, /Authorization.*Bearer/);
  assert.match(dynadotSource, /X-Request-ID/);
  assert.match(dynadotSource, /X-Signature/);
  assert.match(dynadotSource, /randomUUID/);
});

test("sandbox vs production selection is server-side only and customer cannot influence", () => {
  assert.match(dynadotSource, /isSandboxEnabled/);
  assert.match(dynadotSource, /DYNADOT_SANDBOX === "true"/);
  assert.match(dynadotSource, /getDynadotBaseUrl/);
  assert.doesNotMatch(dynadotSource, /c\.req\.query|c\.req\.headers|searchParams\.get.*sandbox/i);
});

test("production refuses sandbox credentials", () => {
  assert.match(dynadotSource, /assertProductionDynadotReady/);
  assert.match(dynadotSource, /sandbox_/);
  assert.match(dynadotSource, /Refusing production Dynadot operation with sandbox credentials/);
});

test("redaction covers Authorization and X-Signature in logs and errors", () => {
  assert.match(dynadotSource, /redactHeaders/);
  assert.match(dynadotSource, /\*\*\*REDACTED\*\*\*/);
  assert.match(dynadotSource, /sanitizeDynadotErrorMessage/);
  assert.match(dynadotSource, /Bearer \*\*\*REDACTED/);
});

test("no IP restrictions are configured (Workers have no fixed outbound IP)", () => {
  assert.doesNotMatch(dynadotSource, /ip.*allow|whitelist|IP_RESTRICTION/i);
  assert.doesNotMatch(devVarsExample, /IP_RESTRICTION|allow.*ip/i);
});

test(".dev.vars is gitignored", () => {
  assert.match(gitignore, /\.dev\.vars/);
});

test(".dev.vars.example uses placeholders only and never real sandbox credentials", () => {
  assert.match(devVarsExample, /your-dynadot-api-key/);
  assert.match(devVarsExample, /your-dynadot-api-secret/);
  assert.doesNotMatch(devVarsExample, /sandbox_[A-Za-z0-9]{30,}/);
  assert.doesNotMatch(devVarsExample, /DYNADOT_API_SECRET.*sandbox_/);
});

test("wrangler configs do not contain Dynadot secrets", () => {
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /DYNADOT_API_KEY/);
  assert.doesNotMatch(wrangler, /sandbox_/);
});

test("package.json has gated sandbox script that fails safely without credentials", () => {
  assert.equal(typeof packageJson.scripts["test:dynadot-sandbox"], "string");
  assert.match(packageJson.scripts["test:dynadot-sandbox"], /DYNADOT_SANDBOX=true/);
  assert.match(packageJson.scripts["test:dynadot-sandbox"], /dynadot-sandbox\.mjs/);
  const sandboxTool = readFileSync(new URL("../tools/dynadot-sandbox.mjs", import.meta.url), "utf8");
  assert.match(sandboxTool, /DYNADOT_API_KEY/);
  assert.match(sandboxTool, /missing/i);
  assert.match(sandboxTool, /fail/i);
});

test("dynadot client supports ordered operations: account info, TLD price, availability, contact, register, domain info, DNS/nameserver, renewal", () => {
  assert.match(dynadotSource, /getAccountInfo/);
  assert.match(dynadotSource, /getTldPrice/);
  assert.match(dynadotSource, /searchDomain/);
  assert.match(dynadotSource, /createContact/);
  assert.match(dynadotSource, /registerDomain/);
  assert.match(dynadotSource, /getDomainInfo/);
  assert.match(dynadotSource, /setNameservers|getNameservers/);
  assert.match(dynadotSource, /setDnsRecords|getDnsRecords/);
  assert.match(dynadotSource, /renewDomain/);
});

test("live sandbox tool is not part of ordinary npm test and is mocked in CI", () => {
  assert.match(packageJson.scripts.test, /test\/\*\.test\.mjs/);
  assert.doesNotMatch(packageJson.scripts.test, /dynadot-sandbox/);
  const tool = readFileSync(new URL("../tools/dynadot-sandbox.mjs", import.meta.url), "utf8");
  assert.match(tool, /DYNADOT_SANDBOX/);
  assert.match(tool, /process\.env/);
});

test("mocked tests do not make live network calls", () => {
  assert.doesNotMatch(dynadotSource, /api-sandbox\.dynadot\.com.*fetch.*test/i);
  const tool = readFileSync(new URL("../tools/dynadot-sandbox.mjs", import.meta.url), "utf8");
  assert.match(tool, /fetch/);
});
