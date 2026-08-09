import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyManagedSpokenForms, applyPronunciations, mergeWav, narrationChunks, narrationSections, narrationText, pronunciationReplacements, ttsBytes, wavAssembly, TTS_CHUNK_MAX, TTS_HARD_PAUSE, TTS_MODEL, TTS_PUNCTUATION_PAUSE_SECONDS, TTS_SOFT_PAUSE, TTS_STRUCTURE_PAUSE_SECONDS, TTS_TEXT_MAX, TTS_TITLE_PAUSE_SECONDS } from "../src/tts.ts";

function wav(samples) {
  const bytes = new Uint8Array(44 + samples.length);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]])
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  view.setUint32(40, samples.length, true); bytes.set(samples, 44);
  return bytes;
}

test("narration text keeps readable content and removes markdown plumbing", () => {
  const text = narrationText("A useful title", "# Opening\n\nRead [the evidence](https://example.com).\n\n![Chart](chart.png)\n\n```js\nsecret();\n```")
    .replaceAll(TTS_HARD_PAUSE, "");
  assert.match(text, /^A useful title\. \.\.\. Opening\./);
  assert.match(text, /Read the evidence/);
  assert.match(text, /Chart/);
  assert.doesNotMatch(text, /https:|secret\(\)|```|#/);
  assert.equal(TTS_TEXT_MAX, 10_000);
});

test("narration adds structural pauses and conservative spoken forms", () => {
  const text = narrationText(
    "AI and the UK",
    "Dr. Jones compared the API vs. the old URL.\n\n## Results\n\n- Faster HTTP requests\n- Clearer HTML output"
  ).replaceAll(TTS_HARD_PAUSE, "\n\n").replaceAll(TTS_SOFT_PAUSE, " ");
  assert.match(text, /^aiye eye and the U K\./);
  assert.match(text, /Doctor Jones compared the A P I versus the old U R L\./);
  assert.match(text, /Results\.\n\nFaster/);
  assert.match(text, /Faster H T T P requests\.\n\nClearer H T M L output\./);
});

test("known MeloTTS pronunciation quirks use a deterministic dictionary", () => {
  const sections = narrationSections("Plugin support", "A plugin, plugins, plug-in and plug-ins.");
  assert.equal(sections.title, "plug inn support.");
  assert.equal(sections.body, "A plug inn, plug inns, plug inn and plug inns.");
  assert.doesNotMatch(`${sections.title} ${sections.body}`, /\bplugins?|\bplug-ins?\b/i);
});

test("product names and formatting keep stable syllable boundaries", () => {
  const sections = narrationSections("Cloudflare formatting", "Cloudflare makes formatting simple.");
  assert.equal(sections.title, "Cloud Flare format-ting.");
  assert.equal(sections.body, "Cloud Flare makes format-ting simple.");
});

test("technical security terms use explicit spoken forms", () => {
  const sections = narrationSections(
    "PBKDF2-HMAC-SHA256 and OWASP",
    "AI, SHA256, OWASP, and CPU are discussed."
  );
  assert.match(sections.title, /P B K D F two H M A C S H A two five six/);
  assert.match(sections.body, /aiye eye, S H A two five six, O Wasp, and C P U/);
});

test("PNG is spelled out letter by letter", () => {
  const sections = narrationSections("PNG favicon", "Upload a PNG image.");
  assert.equal(sections.title, "P N G favicon.");
  assert.equal(sections.body, "Upload a P N G image.");
});

test("managed pronunciation entries apply to future narration", () => {
  assert.equal(applyManagedSpokenForms("Use UI in the editor.", [{ original: "UI", spoken: "U I" }]), "Use U I in the editor.");
  assert.equal(narrationText("UI guide", "Use UI in the editor.", [{ original: "UI", spoken: "U I" }]), "U I guide. ... Use U I in the editor.");
});

test("ambiguous read uses the present-tense pronunciation in clear contexts", () => {
  const text = narrationText(
    "As you read this guide",
    "As you read this guide, you can read more about the design. I read it yesterday.",
  );
  assert.match(text, /As you reed this guide\./);
  assert.match(text, /As you reed this guide, you can reed more/);
  assert.match(text, /I read it yesterday/);
});

test("reading uses the present pronunciation in compound phrases", () => {
  const text = narrationText("Estimating reading time", "Estimating reading time helps readers plan.");
  assert.match(text, /Estimating reeding time\./);
  assert.match(text, /Estimating reeding time helps/);
});

test("login is spoken as the verb phrase log in", () => {
  const text = narrationText("Remember login details", "Remember login details when you return.");
  assert.equal(text, "Remember log in details. ... Remember log in details when you return.");
});

test("configuring receives clear syllable boundaries", () => {
  const text = narrationText("Stop configuring", "Stop configuring and start writing.");
  assert.equal(text, "Stop con fig er ing. ... Stop con fig er ing and start writing.");
});

test("calmer uses its tested spoken form", () => {
  assert.match(narrationText("A calmer introduction", "The tone is calmer."), /carlmar/);
});

test("title is a standalone neutral statement before the article body", () => {
  const sections = narrationSections("AI and the UK", "## Opening\n\nThe article begins.");
  assert.equal(sections.title, "aiye eye and the U K.");
  assert.equal(sections.body.replaceAll(TTS_HARD_PAUSE, "\n\n"), "\n\nOpening.\n\nThe article begins.");
  assert.equal(TTS_TITLE_PAUSE_SECONDS, 1.5);
});

test("narration omits emoji and lengthens pauses after full stops", () => {
  const sections = narrationSections(
    "A calm title 🎙️",
    "First sentence. Second sentence 👩🏽‍💻 continues.\n\nThird paragraph 🇬🇧 1️⃣ ends.",
  );
  assert.equal(sections.title, "A calm title.");
  assert.equal(
    sections.body,
    "First sentence.\n\nSecond sentence continues.\n\nThird paragraph ends.",
  );
  assert.doesNotMatch(sections.body, /🎙|👩|💻|🇬🇧|1️⃣/gu);
});

test("narration removes separators inside numbers", () => {
  const text = narrationText("Usage", "The allowance is 1,000 credits, and 1,2 is unusual.");
  assert.doesNotMatch(text, /1,000/);
  assert.match(text, /1000/);
  assert.doesNotMatch(text, /1,2/);
});

test("hostnames are spoken with explicit dots", () => {
  const text = narrationText("Visit development.blognice.com", "Read development.blognice.com or https://www.blognice.com for more.");
  assert.match(text, /development dot blognice dot com/);
  assert.match(text, /www dot blognice dot com/);
  assert.doesNotMatch(text, /https:\/\//);
});

test("headings and spoken numbered markers receive explicit pauses", () => {
  const sections = narrationSections(
    "A list",
    "## Priorities\n1. First item\n2) Second item\n27. Final item",
  );
  assert.equal(
    sections.body.replaceAll(TTS_HARD_PAUSE, "\n\n"),
    "\n\nPriorities.\n\none.\n\nFirst item.\n\ntwo.\n\nSecond item.\n\ntwenty seven.\n\nFinal item.\n\n",
  );
  const numberedHeading = narrationSections("A list", "# 1.\n\nOpening text.");
  assert.equal(numberedHeading.body.replaceAll(TTS_HARD_PAUSE, "\n\n"), "\n\none.\n\nOpening text.");
  const internalHeading = narrationSections("A list", "Introductory text.\n## Next section\nFollowing text.");
  assert.equal(
    internalHeading.body.replaceAll(TTS_HARD_PAUSE, "\n\n"),
    "Introductory text.\n\nNext section.\n\nFollowing text.",
  );
  assert.equal(TTS_STRUCTURE_PAUSE_SECONDS, 0.65);
  assert.equal(TTS_PUNCTUATION_PAUSE_SECONDS, 0.35);
});

test("a completed list receives a guaranteed pause before following prose", () => {
  const sections = narrationSections(
    "Blog Nice versus WordPress",
    "Starting a WordPress blog often involves choosing:\n\n- A hosting provider\n- A domain registrar\n- A collection of plugins\n- An image-optimization plugin\n\nBlog Nice takes a much shorter route.",
  );
  assert.match(
    sections.body,
    new RegExp(`An image-optimization plug inn\\.${TTS_HARD_PAUSE}Blog Nice takes a much shorter route\\.`),
  );
});

test("colons and semicolons receive guaranteed structural pauses", () => {
  const sections = narrationSections(
    "Punctuation",
    "Choose carefully: speed matters; reliability matters.\n\nOptions include:\n\n- A first option\n- A second option",
  );
  assert.match(sections.body, new RegExp(`carefully:${TTS_SOFT_PAUSE}\\s+speed matters;${TTS_SOFT_PAUSE}\\s+reliability matters\\.`));
  assert.match(sections.body, new RegExp(`Options include:${TTS_SOFT_PAUSE}\\s+A first option\\.`));
});

test("MeloTTS output supports both binary and base64 binding responses", () => {
  assert.equal(TTS_MODEL, "@cf/myshell-ai/melotts");
  assert.deepEqual([...ttsBytes(new Uint8Array([1, 2, 3]))], [1, 2, 3]);
  assert.deepEqual([...ttsBytes({ audio: btoa("mp3") })], [109, 112, 51]);
});

test("pronunciation replacements are constrained and cannot rewrite narration", () => {
  const source = "Siobhan visited Worcestershire with the API team.";
  const replacements = pronunciationReplacements(JSON.stringify({ replacements: [
    { original: "Siobhan", spoken: "Shuh-vawn" },
    { original: "Worcestershire", spoken: "Wooster-sher" },
    { original: "missing", spoken: "invented" },
    { original: "API team", spoken: "A P I team!" },
    { original: "plugins", spoken: "ploogins" },
    { original: "Siobhan", spoken: "duplicate" },
  ] }), source);
  assert.deepEqual(replacements, [
    { original: "Worcestershire", spoken: "Wooster-sher" },
    { original: "Siobhan", spoken: "Shuh-vawn" },
  ]);
  assert.equal(
    applyPronunciations(source, replacements),
    "Shuh-vawn visited Wooster-sher with the API team.",
  );
  assert.deepEqual(pronunciationReplacements("not json", source), []);
  assert.deepEqual(
    pronunciationReplacements('{"replacements":[{"original":"plugins","spoken":"ploogins"}]}', "Use plugins here."),
    [],
  );
});

test("long narration splits on sentences and WAV segments merge into one file", () => {
  const text = "A complete sentence for narration. ".repeat(220).trim();
  const chunks = narrationChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= TTS_CHUNK_MAX));
  assert.equal(chunks.join(" "), text);

  const merged = mergeWav([wav(new Uint8Array([1, 2])), wav(new Uint8Array([3, 4, 5, 6]))]);
  const view = new DataView(merged.buffer);
  assert.equal(view.getUint32(4, true), merged.length - 8);
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual([...merged.slice(44)], [1, 2, 3, 4, 5, 6]);
});

test("WAV assembly inserts an exact 1.5-second pause after the title", () => {
  const assembly = wavAssembly(
    [wav(new Uint8Array([1, 2])), wav(new Uint8Array([3, 4, 5, 6]))],
    TTS_TITLE_PAUSE_SECONDS,
  );
  assert.equal(assembly.size, 44 + 2 + 72_000 + 4);
  assert.deepEqual([...assembly.samples[0]], [1, 2]);
  assert.equal(assembly.samples[1].length, 72_000);
  assert.ok(assembly.samples[1].every((byte) => byte === 0));
  assert.deepEqual([...assembly.samples[2]], [3, 4, 5, 6]);
  assert.equal(new DataView(assembly.header.buffer).getUint32(40, true), 72_006);
});

test("WAV assembly can insert guaranteed silence after structural segments", () => {
  const assembly = wavAssembly(
    [wav(new Uint8Array([1, 2])), wav(new Uint8Array([3, 4]))],
    [0.65, 0],
  );
  assert.equal(assembly.samples[1].length, 31_200);
  assert.ok(assembly.samples[1].every((byte) => byte === 0));
});

test("narration is persisted safely and rendered only when assigned", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../schema-posts.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/003-post-audio.sql", import.meta.url), "utf8");

  assert.match(schema, /audio_key\s+TEXT/);
  assert.match(migration, /ALTER TABLE posts ADD COLUMN audio_key TEXT/);
  assert.match(index, /app\.post\("\/admin\/b\/:blogId\/audio\/:id"/);
  assert.match(index, /AUDIO_QUEUE\.send/);
  assert.match(admin, /status\?job=/);
  assert.match(index, /async queue\(batch, env\)/);
  assert.match(index, /processAudioJob\(env, jobMessage\.jobKey\)/);
  assert.match(index, /new FixedLengthStream\(assembly\.size\)/);
  assert.match(index, /MEDIA\.put\(key, fixed\.readable/);
  assert.match(index, /async function preparePronunciations/);
  assert.match(index, /pronunciationReplacements\(String\(result\.response/);
  assert.match(index, /Pronunciation preprocessing failed; using original narration/);
  assert.match(index, /const structuralParts = preparedBody\.split\(TTS_HARD_PAUSE\)/);
  assert.match(index, /const punctuationParts = structuralParts\[partIndex\]\.split\(TTS_SOFT_PAUSE\)/);
  assert.match(index, /TTS_PUNCTUATION_PAUSE_SECONDS/);
  assert.match(index, /isLastChunk && partIndex < structuralParts\.length - 1/);
  assert.match(index, /async function generateSpeechWithRetry/);
  assert.match(index, /async function generateSpeechWithRecovery/);
  assert.match(index, /function splitSpeechPrompt/);
  assert.match(index, /depth < 3 && prompt\.length >= 240/);
  assert.match(index, /3040\|3043\|internal server error\|temporar\|timeout\|overload\|unavailable/);
  assert.match(index, /Workers AI narration quota reached \(3036\)/);
  assert.match(index, /retryDelays = \[250, 500, 1_000, 1_500, 2_000, 2_000/);
  assert.match(index, /if \(index > 0\) await new Promise\(\(resolve\) => setTimeout\(resolve, 350\)\)/);
  assert.match(index, /const generated = await generateSpeechWithRecovery\(c\.env\.AI, prompt\)/);
  assert.match(index, /audio-checkpoints/);
  assert.match(index, /checkpointHash = await sha256hex/);
  assert.match(index, /MEDIA\.get\(checkpointKeys\[index\]\)/);
  assert.match(index, /MEDIA\.delete\(checkpointKeys\)/);
  assert.match(index, /controller\.enqueue\(encoder\.encode\("\\n"\)\)/);
  assert.match(index, /setInterval\(\(\) => \{/);
  assert.match(index, /c\.executionCtx\.waitUntil\(generation\)/);
  assert.match(index, /wavAssembly\(audioParts, prompts\.map\(\(prompt\) => prompt\.pauseAfter\)\)/);
  assert.match(index, /Audio generation failed while \$\{generationStage\}: \$\{detail\}/);
  assert.match(index, /UPDATE posts SET audio_key = \?/);
  assert.match(index, /catch \(error\) \{\s*await c\.env\.MEDIA\.delete\(key\)/);
  assert.match(index, /!obj\.key\.endsWith\("-tts\.mp3"\) && !obj\.key\.endsWith\("-tts\.wav"\)/);
  assert.match(admin, /id="generate-audio"/);
  assert.match(admin, /!result\.ok \|\| result\.data\.error/);
  assert.match(admin, /id="generate-audio"\$\{audioKey \? " hidden"/);
  assert.match(index, /Remove the existing narration before generating a new version/);
  assert.match(admin, /generated from the last saved version/);
  assert.match(render, /class="post-audio"[^>]*aria-label="Listen to this article"/);
  assert.match(render, /__blogniceEvent\("audio_start",location\.pathname\)/);
  assert.match(render, /__blogniceEvent\("audio_complete",location\.pathname\)/);
  assert.doesNotMatch(render, /<strong>Listen to this article<\/strong>/);
  assert.match(render, /\.post-audio \{[^}]*margin-left: auto;/);
  assert.match(render, /post\.audio_key/);
  assert.match(render, /defaultPlaybackRate=\.88/);
});
