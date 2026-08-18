import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { metricsBeacon, analyticsConsentRequired } from "../src/metrics.ts";
import { renderNotFound } from "../src/render.ts";

const fakeTenant = {
  title: "Test Blog",
  description: "Test",
  slug: "test",
  public_id: "test-public",
  accent_color: "#1a8917",
  avatar_key: null,
  footer_name: "",
  custom_domain: null,
};

test("renderNotFound forwards consent flag to beacon and defaults to no-banner", () => {
  const withConsent = renderNotFound(fakeTenant, true);
  const withoutConsent = renderNotFound(fakeTenant, false);
  const defaultConsent = renderNotFound(fakeTenant);
  assert.match(withConsent, /var required=true/);
  assert.match(withoutConsent, /var required=false/);
  assert.match(defaultConsent, /var required=false/);
  assert.doesNotMatch(defaultConsent, /var required=true/);
  assert.match(withConsent, /blognice-consent/);
  assert.match(withoutConsent, /blognice-consent/);
});

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
  assert.match(renderSource, /metricsBeacon\(consentRequired = false\)/);
  // Ensure no remaining true defaults for consent in render.ts
  const trueDefaults = [...renderSource.matchAll(/analyticsConsentRequired = true/g)];
  assert.equal(trueDefaults.length, 0, `expected 0 true defaults, found ${trueDefaults.length}`);
});
