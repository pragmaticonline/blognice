import assert from "node:assert/strict";
import test from "node:test";
import { emailEnabled, sendEmail } from "../src/email.ts";

test("MailNice email integration stays disabled without its secret", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response(null, { status: 200 }); };
  try {
    assert.equal(emailEnabled({ EMAIL_FROM: "hello@example.com" }), false);
    assert.equal(await sendEmail({ EMAIL_FROM: "hello@example.com" }, {
      to: "reader@example.com", subject: "Hello", html: "<p>Hello</p>",
    }), false);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MailNice receives the server-key header and plain-text message body", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify({ status: "success" }), { status: 200 });
  };
  try {
    assert.equal(await sendEmail({
      MAILNICE_API_KEY: " server-secret ",
      EMAIL_FROM: "The Blog <hello@blognice.com>",
      MAILNICE_API_URL: "https://mailer.test/send",
    }, {
      to: "reader@example.com",
      subject: "New post",
      html: '<p>Read <a href="https://example.com/post">the post</a>.</p><hr><p>Unsubscribe <a href="https://example.com/unsubscribe">here</a>.</p>',
    }), true);
    assert.equal(request.input, "https://mailer.test/send");
    assert.equal(request.init.headers["X-Server-API-Key"], "server-secret");
    const body = JSON.parse(request.init.body);
    assert.deepEqual(body.to, ["reader@example.com"]);
    assert.equal(body.from, "The Blog <hello@blognice.com>");
    assert.equal(body.subject, "New post");
    assert.match(body.plain_body, /Read the post \(https:\/\/example\.com\/post\)/);
    assert.match(body.plain_body, /Unsubscribe here \(https:\/\/example\.com\/unsubscribe\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
