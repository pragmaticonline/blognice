import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { metricsBeacon, analyticsConsentRequired } from "../src/metrics.ts";

test("metricsBeacon required flag changes client logic while keeping banner markup", () => {
  const required = metricsBeacon(true);
  const optional = metricsBeacon(false);
  const defaultBeacon = metricsBeacon();
  assert.match(required, /var required=true/);
  assert.match(optional, /var required=false/);
  assert.match(defaultBeacon, /var required=false/);
  assert.match(required, /Help us improve blognice/);
  assert.match(optional, /Help us improve blognice/);
  assert.match(required, /blognice-analytics-consent-v1/);
  assert.match(optional, /blognice-analytics-consent-v1/);
});

test("renderNotFound forwards consent flag to beacon and defaults to no-banner", () => {
  const renderSource = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  assert.match(renderSource, /export function renderNotFound\(tenant: Tenant \| null, analyticsConsentRequired = false\)/);
  assert.match(renderSource, /return shell\(\{\s*tenant,\s*pageTitle:.*analyticsConsentRequired,/s);
  assert.match(renderSource, /shell\(opts:[\s\S]*?analyticsConsentRequired = false/);
  const metricsSource = readFileSync(new URL("../src/metrics.ts", import.meta.url), "utf8");
  assert.match(metricsSource, /export function metricsBeacon\(consentRequired = false\)/);
});

test("analytics consent is EU-gated and server cache varies by cohort", () => {
  for (const c of ["DE", "FR", "GB", "CH", "IS", "NO"]) assert.equal(analyticsConsentRequired(c), true, c);
  for (const c of ["US", "TH", "AU", "JP", "", "XX", "T1"]) assert.equal(analyticsConsentRequired(c), false, c);
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /_bn_consent.*required.*optional/);
  assert.match(indexSource, /analyticsConsentRequired\(c\.req\.raw\.cf\?\.country\)/);
});

test("shell defaults to optional to avoid global popup", () => {
  const renderSource = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  assert.match(renderSource, /shell\(opts:[\s\S]*?analyticsConsentRequired = false/);
  assert.match(renderSource, /renderNotFound\(tenant: Tenant \| null, analyticsConsentRequired = false\)/);
  assert.match(renderSource, /renderHome\([\s\S]*?analyticsConsentRequired = false/);
  const metricsSource = readFileSync(new URL("../src/metrics.ts", import.meta.url), "utf8");
  assert.match(metricsSource, /metricsBeacon\(consentRequired = false\)/);
  // Ensure no remaining true defaults for consent in render.ts
  const trueDefaults = [...renderSource.matchAll(/analyticsConsentRequired = true/g)];
  assert.equal(trueDefaults.length, 0, `expected 0 true defaults, found ${trueDefaults.length}`);
});
