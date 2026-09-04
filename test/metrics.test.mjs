import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsSql,
  archivePreviousDay,
  archivePreviousDayAffiliateEvents,
  auditReport,
  metricsBeacon,
  analyticsConsentRequired,
  affiliateFunnelSeries,
  experimentFunnelSeries,
  recordAffiliateFunnelEvent,
  recordCustomEvent,
  recordAuditEvent,
  recordPageView,
  reportQueries,
} from "../src/metrics.ts";

test("affiliate funnel series fills a bounded 90-day click and sales timeline", async () => {
  const originalFetch = globalThis.fetch;
  let query = "";
  globalThis.fetch = async (_input, init) => {
    query = String(init?.body || "");
    return new Response(JSON.stringify({ data: [
      { date: "2026-09-01", event: "affiliate_click", events: 7 },
      { date: "2026-09-01", event: "affiliate_conversion", events: 2 },
      { date: "2026-09-03", event: "affiliate_click", events: 3 },
    ] }), { status: 200 });
  };
  try {
    const series = await affiliateFunnelSeries({
      CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "token",
    }, 17, 90, new Date("2026-09-03T12:00:00Z"));
    assert.equal(series.length, 90);
    assert.deepEqual(series.slice(-3), [
      { date: "2026-09-01", clicks: 7, sales: 2 },
      { date: "2026-09-02", clicks: 0, sales: 0 },
      { date: "2026-09-03", clicks: 3, sales: 0 },
    ]);
    assert.match(query, /index1 = '17'/);
    assert.match(query, /blob1 IN \('affiliate_click', 'affiliate_conversion'\)/);
    assert.match(query, /SUM\(_sample_interval\) AS events/);
    assert.match(query, /2026-06-06 00:00:00/);
    assert.doesNotMatch(query, /account|email|customer/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
    blobs: ["affiliate_conversion", "link", "stripe", "affiliate-1", "", ""],
    doubles: [1],
  }]);
  assert.doesNotMatch(JSON.stringify(points), /account|email|visitor|cookie|payment/i);
});

test("experiment analytics use bounded variant fields and sampling-aware daily trends", async () => {
  const points = [];
  recordAffiliateFunnelEvent({ AFFILIATE_EVENTS: { writeDataPoint(point) { points.push(point); } } }, 17, {
    name: "affiliate_offer_exposure", source: "link", policyVersion: "affiliate-1",
    experimentKey: "affiliate-offer-v1", variant: "focused",
  });
  assert.deepEqual(points[0].blobs, ["affiliate_offer_exposure", "link", "", "affiliate-1", "affiliate-offer-v1", "focused"]);

  const originalFetch = globalThis.fetch;
  let query = "";
  globalThis.fetch = async (_input, init) => {
    query = String(init?.body || "");
    return new Response(JSON.stringify({ data: [{ date: "2026-09-03", variant: "focused", event: "affiliate_offer_exposure", events: 11 }] }), { status: 200 });
  };
  try {
    const rows = await experimentFunnelSeries({ CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "token" }, "affiliate-offer-v1", 14, new Date("2026-09-03T12:00:00Z"));
    assert.deepEqual(rows.at(-1), { date: "2026-09-03", variant: "focused", event: "affiliate_offer_exposure", events: 11 });
    assert.match(query, /blob5 = 'affiliate-offer-v1'/);
    assert.match(query, /SUM\(_sample_interval\)/);
    assert.doesNotMatch(query, /journey|account|email|cookie/i);
  } finally { globalThis.fetch = originalFetch; }
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

test("subscriber lifecycle uses the shared Analytics Engine dataset and contains no PII", () => {
  const cases = [
    "email_subscribe_requested",
    "email_subscribed",
    "email_unsubscribed",
    "push_subscribed",
    "push_unsubscribed",
    "email_bounced",
    "email_complained",
    "email_opened",
    "email_clicked",
    "push_delivered",
    "push_clicked",
  ];
  for (const name of cases) {
    let point;
    const env = { EVENTS: { writeDataPoint(value) { point = value; } } };
    recordCustomEvent(env, 7, {
      name,
      path: "/",
      visitor: "8da6baef-62fa-426f-9fb4-fbd8c390fe50",
      country: "TH",
      device: "Mobile",
      browser: "Safari",
    });
    assert.deepEqual(point.indexes, ["7"]);
    assert.equal(point.blobs[0], name);
    assert.equal(point.blobs[1], "/");
    assert.deepEqual(point.doubles, [1]);
    assert.doesNotMatch(JSON.stringify(point), /@example|endpoint=/i);
    assert.doesNotMatch(point.blobs.join('|'), /@/);
  }
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

test("report queries include subscriber lifecycle breakdowns", () => {
  const queries = reportQueries(7, 30);
  assert.match(queries.subscriberSummary, /FROM blognice_events/);
  assert.match(queries.subscriberSummary, /email_subscribed/);
  assert.match(queries.subscriberSummary, /push_subscribed/);
  assert.match(queries.subscriberDaily, /GROUP BY date/);
  assert.match(queries.subscriberSummary, /index1 = '7'/);
  assert.match(queries.subscriberSummary, /SUM\(_sample_interval\)|sumIf/);
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

test("metrics report aggregates subscriber lifecycle daily and summary", async () => {
  const originalFetch = globalThis.fetch;
  const queries = [];
  globalThis.fetch = async (_url, init) => {
    const q = String(init?.body || "");
    queries.push(q);
    if (q.includes("email_subscribed") && q.includes("GROUP BY date")) {
      return new Response(JSON.stringify({ data: [{ date: "2026-09-01", email_subscribed: 2, email_unsubscribed: 1, push_subscribed: 3, push_unsubscribed: 0 }] }), { status: 200 });
    }
    if (q.includes("email_subscribed") && !q.includes("GROUP BY date")) {
      return new Response(JSON.stringify({ data: [{ email_subscribed: 5, email_unsubscribed: 2, push_subscribed: 7, push_unsubscribed: 1 }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  try {
    const { metricsReport } = await import("../src/metrics.ts");
    const report = await metricsReport({ CF_ACCOUNT_ID: "a", CF_ANALYTICS_TOKEN: "t" }, 7, 30);
    assert.equal(report.subscribers.emailSubscribed, 5);
    assert.equal(report.subscribers.emailUnsubscribed, 2);
    assert.equal(report.subscribers.pushSubscribed, 7);
    assert.equal(report.subscribers.pushUnsubscribed, 1);
    assert.equal(report.subscribers.emailBounced, 0);
    assert.deepEqual(report.subscribers.daily[0], { date: "2026-09-01", emailSubscribed: 2, emailUnsubscribed: 1, pushSubscribed: 3, pushUnsubscribed: 0, emailBounced: 0, emailComplained: 0, emailOpened: 0, emailClicked: 0, pushDelivered: 0, pushClicked: 0 });
    assert.ok(queries.some((q) => q.includes("email_subscribed") && q.includes("index1 = '7'")));
  } finally { globalThis.fetch = originalFetch; }
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
