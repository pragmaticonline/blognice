import assert from "node:assert/strict";
import test from "node:test";
import {
  ROOM_NONCE_TTL_MS,
  signRoomRequest,
  timingSafeEqualBytes,
  verifyRoomRequest,
} from "../src/comment-room-protocol.ts";

const SECRET = "test-room-secret-00000000000000000001";
const nowMs = () => Date.now();

async function fresh() {
  const seen = new Set();
  const { nonce, mac } = await signRoomRequest(SECRET, "POST", "/internal/broadcast", '{"type":"comment-votes"}');
  return { seen, nonce, mac };
}

test("accepts a fresh signature and records the nonce", async () => {
  const { seen, nonce, mac } = await fresh();
  const ok = await verifyRoomRequest(SECRET, "POST", "/internal/broadcast", '{"type":"comment-votes"}', nonce, mac, seen, nowMs());
  assert.equal(ok, true);
  assert.ok(seen.has(nonce));
});

test("rejects replayed nonces", async () => {
  const { seen, nonce, mac } = await fresh();
  const args = [SECRET, "POST", "/internal/broadcast", '{"type":"comment-votes"}', nonce, mac, seen, nowMs()];
  assert.equal(await verifyRoomRequest(...args), true);
  assert.equal(await verifyRoomRequest(...args), false);
});

test("rejects expired nonces", async () => {
  const { seen, nonce, mac } = await fresh();
  const ok = await verifyRoomRequest(SECRET, "POST", "/internal/broadcast", '{"type":"comment-votes"}', nonce, mac, seen, Date.now() + ROOM_NONCE_TTL_MS + 1000);
  assert.equal(ok, false);
});

test("nonce TTL boundary is inclusive", async () => {
  const check = (at) => fresh().then(({ nonce, mac }) =>
    verifyRoomRequest(SECRET, "POST", "/internal/broadcast", '{"type":"comment-votes"}', nonce, mac, new Set(), Number(nonce.split(":")[0]) + at));
  assert.equal(await check(ROOM_NONCE_TTL_MS), true);
  assert.equal(await check(ROOM_NONCE_TTL_MS + 1), false);
});

test("rejects wrong secrets, tampered bodies, and malformed macs", async () => {
  const { nonce, mac } = await fresh();
  const base = ["POST", "/internal/broadcast", '{"type":"comment-votes"}', nonce, mac, new Set(), nowMs()];
  assert.equal(await verifyRoomRequest("wrong-secret-00000000000000000000002", ...base), false);
  assert.equal(await verifyRoomRequest(SECRET, "POST", "/internal/broadcast", '{"type":"tampered"}', nonce, mac, new Set(), nowMs()), false);
  assert.equal(await verifyRoomRequest(SECRET, "POST", "/internal/broadcast", '{"type":"comment-votes"}', nonce, "zz", new Set(), nowMs()), false);
  assert.equal(await verifyRoomRequest(SECRET, "POST", "/internal/broadcast", '{"type":"comment-votes"}', nonce, mac.slice(0, 8), new Set(), nowMs()), false);
  assert.equal(await verifyRoomRequest(SECRET, "POST", "/internal/broadcast", '{"type":"comment-votes"}', null, mac, new Set(), nowMs()), false);
  assert.equal(await verifyRoomRequest(SECRET, "POST", "/internal/broadcast", '{"type":"comment-votes"}', "not-a-nonce", mac, new Set(), nowMs()), false);
});

test("timingSafeEqualBytes compares lengths and bits", () => {
  assert.equal(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])), false);
  assert.equal(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
});
