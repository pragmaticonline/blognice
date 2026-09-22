import assert from "node:assert/strict";
import test from "node:test";
import { MODEL, assessRanking, buildQuestions, rankCandidates, scoreCandidates } from "../scripts/rerank.mjs";

const CANDIDATES = [
  { id: "a", path: "src/a.ts", snippet: "upload endpoint here" },
  { id: "b", path: "src/b.ts", snippet: "unrelated styles" },
  { id: "c", path: "src/c.ts", snippet: "passing mention" },
];

test("buildQuestions emits one noul per candidate referencing its slice", () => {
  const q = buildQuestions("where is upload?", CANDIDATES);
  assert.equal(Object.keys(q).length, 3);
  for (const [i, c] of CANDIDATES.entries()) {
    const entry = q[`rel_${i}`];
    assert.equal(entry.type, "noul");
    assert.match(JSON.stringify(entry), /upload\?/);
    assert.ok(JSON.stringify(entry.instructions.candidate).includes(c.path));
  }
});

test("rankCandidates sorts by probability, nulls last", () => {
  const ranked = rankCandidates(CANDIDATES, {
    rel_0: { type: "noul", noul: 0.2 },
    rel_1: { type: "noul", noul: 0.9 },
  });
  assert.deepEqual(ranked.map((c) => c.id), ["b", "a", "c"]);
  assert.equal(ranked[2].p, null);
});

test("scoreCandidates posts one batched request and returns ranked + usage", async () => {
  let seenBody = null;
  const stubFetch = async (_url, opts) => {
    seenBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        answers: { rel_0: { type: "noul", noul: 0.1 }, rel_1: { type: "noul", noul: 0.8 } },
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    };
  };
  const { ranked, usage, ms } = await scoreCandidates("q?", CANDIDATES.slice(0, 2), {
    apiKey: "k",
    fetchImpl: stubFetch,
  });
  assert.equal(seenBody.model, MODEL);
  assert.notEqual(MODEL, "jev-latest", "model version is pinned, aliases move");
  assert.equal(Object.keys(seenBody.questions).length, 2);
  assert.deepEqual(ranked.map((c) => c.id), ["b", "a"]);
  assert.deepEqual(usage, { input_tokens: 100, output_tokens: 10 });
  assert.ok(ms >= 0);
});

test("buildQuestions carries the shortlist evidence, not just the excerpt", () => {
  const q = buildQuestions("where is upload?", [
    { id: "a", path: "src/a.ts", snippet: "app.post upload", why: "grep hit: comments/avatar on line 422" },
    { id: "b", path: "src/b.ts", snippet: "unrelated styles" },
  ]);
  const cand = q.rel_0.instructions.candidate;
  assert.equal(cand.path, "src/a.ts");
  assert.match(JSON.stringify(cand), /grep hit/);
  assert.equal(q.rel_1.instructions.candidate.path, "src/b.ts");
});

test("assessRanking floors trust at 0.5 top probability", () => {
  assert.deepEqual(assessRanking([{ id: "a", p: 0.9 }, { id: "b", p: 0.1 }]), {
    trustworthy: true, top: 0.9,
  });
  const flat = assessRanking([{ id: "a", p: 0.46 }, { id: "b", p: 0.41 }]);
  assert.equal(flat.trustworthy, false);
  assert.match(flat.reason, /grep/);
  assert.equal(assessRanking([{ id: "a", p: null }]).trustworthy, false);
  assert.equal(assessRanking([]).trustworthy, false);
});

test("scoreCandidates returns the answering model for the log", async () => {
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({ answers: {}, usage: null }),
  });
  const out = await scoreCandidates("q?", CANDIDATES.slice(0, 1), { apiKey: "k", fetchImpl: stubFetch });
  assert.equal(out.model, MODEL);
});

test("scoreCandidates throws a short error on HTTP failure", async () => {
  const stubFetch = async () => ({ ok: false, status: 401, text: async () => "nope" });
  await assert.rejects(
    scoreCandidates("q?", CANDIDATES.slice(0, 1), { apiKey: "k", fetchImpl: stubFetch }),
    /HTTP 401/
  );
});
