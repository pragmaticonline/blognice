import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsSql,
  archivePreviousDay,
  archivePreviousDayAffiliateEvents,
  auditReport,
  metricsBeacon,
  analyticsConsentRequired,
  recordAffiliateFunnelEvent,
  recordCustomEvent,
  recordAuditEvent,
  recordPageView,
  reportQueries,
} from "../src/metrics.ts";

test("affiliate funnel analytics are keyed by Affiliate and contain no customer identity", () => {
  const points = [];
  recordAffiliateFunnelEvent({
    AFFILIATE_EVENTS: { writeDataPoint(point) { points.push(point); } },
  }, 17, {
    name: "affiliate_conversion",
    source: "link",
    provider: "stripe",
    policyVersion: "affiliate-1",
  });

  assert.deepEqual(points, [{
    indexes: ["17"],
    blobs: ["affiliate_conversion", "link", "stripe", "affiliate-1"],
    doubles: [1],
  }]);
  assert.doesNotMatch(JSON.stringify(points), /account|email|visitor|cookie|payment/i);
});

test("report queries are tenant scoped, time bounded, and sampling aware", () => {
  const queries = reportQueries(42, 30);
  for (const query of Object.values(queries)) {
    assert.match(query, /index1 = '42'/);
    assert.match(query, /INTERVAL '30' DAY/);
  }
  assert.match(queries.summary, /SUM\(_sample_interval\) AS views/);
  assert.match(queries.summary, /count\(DISTINCT blob4\) AS visitors/);
  assert.doesNotMatch(queries.summary, /uniq\(/);
  assert.match(queries.daily, /formatDateTime\(timestamp, '%Y-%m-%d'\)/);
  assert.doesNotMatch(queries.daily, /toDate\(/);
});

test("audit timestamps use minutes rather than ClickHouse month names", async () => {
  const originalFetch = globalThis.fetch;
  let query = "";
  globalThis.fetch = async (_input, init) => {
    query = String(init?.body || "");
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  try {
    await auditReport({ CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "token" }, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(query, /formatDateTime\(timestamp, '%Y-%m-%d %H:%i:%S'\)/);
  assert.doesNotMatch(query, /%H:%M:%S/);
});

test("recorded page views follow the documented Analytics Engine schema", () => {
  let point;
  const env = { METRICS: { writeDataPoint(value) { point = value; } } };
  recordPageView(env, 7, {
    path: "/hello",
    referrer: "example.com",
    country: "TH",
    visitor: "8da6baef-62fa-426f-9fb4-fbd8c390fe50",
    device: "Mobile",
    browser: "Safari",
  });
  assert.deepEqual(point, {
    indexes: ["7"],
    blobs: ["/hello", "example.com", "TH", "8da6baef-62fa-426f-9fb4-fbd8c390fe50", "Mobile", "Safari"],
    doubles: [1],
  });
});

test("audio engagement uses a separate Analytics Engine dataset", () => {
  let point;
  const env = { EVENTS: { writeDataPoint(value) { point = value; } } };
  recordCustomEvent(env, 7, {
    name: "audio_start",
    path: "/hello",
    visitor: "8da6baef-62fa-426f-9fb4-fbd8c390fe50",
    country: "TH",
    device: "Mobile",
    browser: "Safari",
  });
  assert.deepEqual(point.indexes, ["7"]);
  assert.deepEqual(point.blobs, ["audio_start", "/hello", "8da6baef-62fa-426f-9fb4-fbd8c390fe50", "TH", "Mobile", "Safari"]);
});

test("audit events use the shared Analytics Engine dataset and a 90-day query", async () => {
  let point;
  recordAuditEvent({ EVENTS: { writeDataPoint(value) { point = value; } } }, 7, {
    action: "post_published", target: "hello-world", actor: "42",
  });
  assert.deepEqual(point, {
    indexes: ["7"],
    blobs: ["audit:post_published", "hello-world", "42", "", "", ""],
    doubles: [1],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.match(String(init?.body), /INTERVAL '90' DAY/);
    assert.match(String(init?.body), /blob1 LIKE 'audit:%'/);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  try { assert.deepEqual(await auditReport({ CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "token" }, 7), { entries: [], hasMore: false }); }
  finally { globalThis.fetch = originalFetch; }
});

test("public beacon avoids query strings and raw referrer storage", () => {
  const script = metricsBeacon();
  assert.match(script, /path:location\.pathname/);
  assert.match(script, /referrer:referrerHost\(\)/);
  assert.doesNotMatch(script, /location\.search/);
  assert.match(script, /x-blognice-consent/);
  assert.match(script, /blognice-analytics-consent-v1/);
  assert.match(script, /_blognice\/events/);
  assert.match(script, /https:\/\/www\.blognice\.com\/privacy/);
});

test("public beacon browser script is syntactically valid", () => {
  for (const required of [true, false]) {
    const beacon = metricsBeacon(required);
    const script = beacon.slice(beacon.indexOf("<script>") + 8, beacon.lastIndexOf("</script>"));
    assert.doesNotThrow(() => new Function(script));
  }
});

test("analytics consent is required for EEA, UK, and Switzerland, but unknown is off", () => {
  for (const country of ["DE", "IS", "LI", "NO", "GB", "CH"]) assert.equal(analyticsConsentRequired(country), true, country);
  for (const country of ["", "TH", "US", "AU"]) assert.equal(analyticsConsentRequired(country), false, country);
  assert.match(metricsBeacon(true), /Help us improve blognice/);
  assert.match(metricsBeacon(false), /Help us improve blognice/);
  assert.doesNotMatch(metricsBeacon(true), /createElement\("button"\).*Analytics preferences/);
});

test("report queries include aggregate audience and audio breakdowns", () => {
  const queries = reportQueries(7, 30);
  assert.match(queries.countries, /blob3 AS name/);
  assert.match(queries.devices, /blob5 AS name/);
  assert.match(queries.browsers, /blob6 AS name/);
  assert.match(queries.audioSummary, /FROM blognice_events/);
  assert.match(queries.audioSummary, /sumIf\(_sample_interval, blob1 = 'audio_start'\)/);
  assert.match(queries.audioPages, /blob1 IN \('audio_start', 'audio_complete'\)/);
});

test("daily archive stores aggregate rows under a date-partitioned R2 key", async () => {
  const originalFetch = globalThis.fetch;
  let put;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ tenant_id: "7", path: "/hello", views: "3", visitors: "2" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const env = {
      CF_ACCOUNT_ID: "account",
      CF_ANALYTICS_TOKEN: "token",
      METRICS_ARCHIVE: {
        async put(key, value, options) { put = { key, value, options }; },
      },
    };
    const key = await archivePreviousDay(env, new Date("2026-08-02T12:00:00Z"));
    assert.equal(key, "daily/2026/08/2026-08-01.json");
    assert.equal(put.key, key);
    assert.equal(JSON.parse(put.value).date, "2026-08-01");
    assert.equal(put.options.customMetadata.schema, "blognice-pageviews-v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("affiliate daily archive is aggregate-only and deletes data beyond 730 days", async () => {
  const originalFetch = globalThis.fetch;
  let query = "";
  let put;
  const deleted = [];
  globalThis.fetch = async (_url, init) => {
    query = String(init.body);
    return new Response(JSON.stringify({
      data: [{ affiliate_id: "17", event: "affiliate_click", source: "link", events: "3" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = {
      CF_ACCOUNT_ID: "account",
      CF_ANALYTICS_TOKEN: "token",
      METRICS_ARCHIVE: {
        async put(key, value, options) { put = { key, value, options }; },
        async delete(key) { deleted.push(key); },
      },
    };
    const key = await archivePreviousDayAffiliateEvents(env, new Date("2026-08-02T12:00:00Z"));
    assert.equal(key, "affiliate/daily/2026/08/2026-08-01.json");
    assert.equal(put.key, key);
    assert.equal(put.options.customMetadata.schema, "blognice-affiliate-events-v1");
    assert.match(query, /FROM blognice_affiliate_events/);
    assert.doesNotMatch(query, /customer|account\.email|referred_account/i);
    assert.deepEqual(deleted, ["affiliate/daily/2024/08/2024-08-01.json"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a dataset awaiting its first write is reported as empty", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    errors: [{ message: "Table blognice_pageviews does not exist" }],
  }), { status: 404, headers: { "content-type": "application/json" } });
  try {
    const rows = await analyticsSql({
      CF_ACCOUNT_ID: "account",
      CF_ANALYTICS_TOKEN: "token",
    }, "SELECT 1");
    assert.deepEqual(rows, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
