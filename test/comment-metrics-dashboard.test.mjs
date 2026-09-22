// Owner metrics Comments panel: headline, per-post rows, empty state.
import assert from "node:assert/strict";
import test from "node:test";
import { metricsPage } from "../src/admin.ts";

const account = {
  email: "owner@example.com",
  billing_status: "inactive",
  crypto_paid_through: 0,
  vip_granted_at: null,
  vip_expires_at: null,
};
const tenant = { public_id: "b_test", slug: "test", title: "Test blog", accent_color: "#146b54" };

function reportWith(comments) {
  return {
    days: 30,
    summary: { views: 0, visitors: 0 },
    daily: [],
    pages: [],
    referrers: [],
    countries: [],
    devices: [],
    browsers: [],
    utmSources: [],
    utmMediums: [],
    utmCampaigns: [],
    audio: { starts: 0, completions: 0, pages: [] },
    subscribers: {
      emailSubscribed: 0, emailUnsubscribed: 0, pushSubscribed: 0, pushUnsubscribed: 0,
      emailBounced: 0, emailComplained: 0, emailOpened: 0, emailClicked: 0,
      pushDelivered: 0, pushClicked: 0, emailDelivered: 0, emailDelayed: 0,
      emailDeliveryFailed: 0, emailHeld: 0, domainDnsError: 0,
      emailTotal: 0, pushTotal: 0, daily: [],
    },
    comments,
  };
}

test("metrics page shows a Comments panel with headline and per-post rows", () => {
  const html = metricsPage(account, tenant, reportWith({
    posted: 9,
    votes: 12,
    pages: [{ path: "/hello", posted: 3, votes: 5 }],
    daily: [{ date: "2026-09-01", posted: 3, votes: 5 }],
  }));
  assert.match(html, /Comments/);
  assert.match(html, /<strong>9<\/strong> comments/);
  assert.match(html, /<strong>12<\/strong> votes/);
  assert.match(html, /\/hello/);
  assert.match(html, /<td class="num">3<\/td>/);
  assert.match(html, /<td class="num">5<\/td>/);
});

test("metrics Comments panel explains an empty period", () => {
  const html = metricsPage(account, tenant, reportWith({ posted: 0, votes: 0, pages: [], daily: [] }));
  assert.match(html, /Comments/);
  assert.match(html, /No comments yet\./);
});

test("metrics Comments panel charts engagements per day", () => {
  const html = metricsPage(account, tenant, reportWith({
    posted: 4,
    votes: 8,
    pages: [{ path: "/hello", posted: 4, votes: 8 }],
    daily: [
      { date: "2026-09-01", posted: 1, votes: 2 },
      { date: "2026-09-02", posted: 3, votes: 6 },
    ],
  }));
  assert.match(html, /Daily engagement/);
  assert.match(html, /2026-09-02: 9 engagements/);
  assert.match(html, /3 comments/);
  assert.match(html, /6 votes/);
});

test("metrics Comments panel explains an empty engagement chart", () => {
  const html = metricsPage(account, tenant, reportWith({
    posted: 0, votes: 0, pages: [], daily: [],
  }));
  assert.match(html, /No engagement yet\./);
});

test("metrics error path is unaffected by the Comments panel", () => {
  const html = metricsPage(account, tenant, null, { error: "boom" });
  assert.match(html, /boom/);
  assert.doesNotMatch(html, /comment_voted/);
});
