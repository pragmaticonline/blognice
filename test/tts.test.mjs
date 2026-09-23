import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
for (const extension of [".html", ".svg"]) {
  require.extensions[extension] = (module, filename) => {
    module.exports = readFileSync(filename, "utf8");
  };
}
import { applyManagedSpokenForms, applyPronunciations, classifyTtsError, mergeWav, narrationChunks, narrationSections, narrationText, pronunciationReplacements, removeCitationClusters, ttsBytes, ttsChunkMax, validWavAudio, wavAssembly, TTS_AURA_CHUNK_MAX, TTS_CHUNK_MAX, TTS_FALLBACK_MODEL, TTS_HARD_PAUSE, TTS_MODEL, TTS_PUNCTUATION_PAUSE_SECONDS, TTS_RETRY_DELAYS, TTS_TRUNCATED_RETRY_DELAYS, TTS_SOFT_PAUSE, TTS_STRUCTURE_PAUSE_SECONDS, TTS_TEXT_MAX, TTS_TITLE_PAUSE_SECONDS } from "../src/tts.ts";

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
  assert.equal(TTS_TEXT_MAX, 20_000);
});

test("narration drops trailing citation-link clusters but keeps prose links", () => {
  const text = narrationText(
    "Safety pause",
    "Both companies announced confidential IPO submissions in June.\n\n[Amodei's proposal](https://a.example), [Reuters on Altman](https://b.example), [Anthropic's announcement](https://c.example), [OpenAI's announcement](https://d.example)."
  ).replaceAll(TTS_HARD_PAUSE, "");
  assert.match(text, /Both companies announced confidential IPO submissions in June/);
  assert.doesNotMatch(text, /Amodei|Reuters|Anthropic|OpenAI|https:/);
  assert.equal(
    removeCitationClusters("Sources: [a](https://a.example), [b](https://b.example)."),
    "",
  );
  assert.equal(
    removeCitationClusters("On CBS, Amodei floated joint governance. [CBS transcript](https://example.com/x)"),
    "On CBS, Amodei floated joint governance.",
  );
  assert.equal(
    removeCitationClusters("*Via [7 Takeaways](https://example.com/x)*"),
    "",
  );
  assert.equal(
    removeCitationClusters("See [a](https://a.example) and [b](https://b.example)."),
    "See",
  );
  assert.equal(
    removeCitationClusters("Further reading: [x](https://example.com/x)"),
    "",
  );
  assert.equal(
    removeCitationClusters("Handing over the technology. [CBS transcript](https://example.com/x)."),
    "Handing over the technology.",
  );
  assert.equal(
    removeCitationClusters("[a](https://a.example), [b](https://b.example)"),
    "",
  );
  assert.equal(
    removeCitationClusters("Read [the evidence](https://example.com)."),
    "Read [the evidence](https://example.com).",
  );
  assert.equal(
    removeCitationClusters("See [a](https://a.example). Later, see [b](https://b.example)."),
    "See [a](https://a.example). Later, see [b](https://b.example).",
  );
});

test("narration drops a mid-body paragraph-final citation cluster", () => {
  const cluster = "[Amodei's proposal](https://darioamodei.com/post/we-must-pace-the-frontier), [Reuters on Altman's remarks](https://www.reuters.com/legal/litigation/openai-ipo-will-not-happen-2026-amid-ai-safety-fears-altman-says-2026-09-12/), [Anthropic's announcement](https://www.anthropic.com/news/confidential-draft-s1-sec), [OpenAI's announcement](https://openai.com/index/openai-submits-confidential-s-1/)";
  const text = narrationText(
    "Safety pause",
    `Intro paragraph here.\r\n\r\nBoth companies announced confidential IPO submissions in June: Anthropic on June 1 and OpenAI on June 8. ${cluster}\r\n\r\nThen I saw the response.`,
  ).replaceAll(TTS_HARD_PAUSE, "");
  assert.match(text, /Anthropic on June 1 and OpenAI on June 8/);
  assert.match(text, /Then I saw the response/);
  assert.doesNotMatch(text, /Amodei's proposal|Reuters on Altman's|Anthropic's announcement|OpenAI's announcement|https:/);
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

test("narration skips Markdown tables", () => {
  const text = narrationText("Table example", "Before the table.\n\n| Name | Status |\n| --- | :---: |\n| Audio | Ready |\n| Image | Pending |\n\nAfter the table.");
  assert.match(text, /Before the table\./);
  assert.match(text, /After the table\./);
  assert.doesNotMatch(text, /Name|Status|Audio|Ready|Image|Pending|\|/);
});

test("audio removal invalidates queued narration before it can attach", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /audio_generation_id = NULL/);
  assert.match(source, /audio_generation_id = \?/);
  assert.match(source, /status = "cancelled"/);
  assert.match(source, /releaseTerminalAudioGeneration/);
  assert.match(source, /published && !can\(role, "posts.publish"\)/);
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
    `First sentence.\n\nSecond sentence continues.${TTS_HARD_PAUSE}Third paragraph ends.`,
  );
  assert.doesNotMatch(sections.body, /🎙|👩|💻|🇬🇧|1️⃣/gu);
});

test("narration pauses between paragraphs instead of ellipses", () => {
  const sections = narrationSections("Title", "First paragraph here.\n\nSecond paragraph here.");
  assert.match(sections.body, /First paragraph here\./);
  assert.match(sections.body, /Second paragraph here\./);
  assert.match(sections.body, /\u241E/);
  assert.doesNotMatch(sections.body, /\.\.\./);
});

test("narration removes separators inside numbers", () => {
  const text = narrationText("Usage", "The allowance is 1,000 credits, and 1,2 is unusual.");
  assert.doesNotMatch(text, /1,000/);
  assert.match(text, /1000/);
  assert.doesNotMatch(text, /1,2/);
});

test("narration expands decimal numbers into spoken words", () => {
  const text = narrationText("Scores", "Version 4.9 scores 48.9 overall, see jev-1.13.0 for details.");
  assert.match(text, /four point nine/);
  assert.match(text, /forty eight point nine/);
  assert.doesNotMatch(text, /4\.9/);
  assert.doesNotMatch(text, /48\.9/);
  // Dotted versions are not decimals; leave their handling unchanged.
  assert.doesNotMatch(text, /one point/);
});

test("hostnames are spoken with explicit dots", () => {
  const text = narrationText("Visit development.blognice.com", "Read development.blognice.com or https://www.blognice.com for more.");
  assert.doesNotMatch(text, /development dot blognice dot com/);
  assert.doesNotMatch(text, /www dot blognice dot com/);
  assert.doesNotMatch(text, /https:\/\//);
  assert.doesNotMatch(text, /blognice/);
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
  assert.match(sections.body, new RegExp(`Options include:${TTS_SOFT_PAUSE}\\s*${TTS_HARD_PAUSE}\\s*A first option\\.`));
});

test("MeloTTS output supports both binary and base64 binding responses", () => {
  assert.equal(TTS_MODEL, "@cf/myshell-ai/melotts");
  assert.deepEqual([...ttsBytes(new Uint8Array([1, 2, 3]))], [1, 2, 3]);
  assert.deepEqual([...ttsBytes({ audio: btoa("mp3") })], [109, 112, 51]);
});

test("TTS errors classify known transient upstream failures without storing raw messages", () => {
  assert.deepEqual(classifyTtsError(new Error("3043: Internal server error")), { transient: true, category: "upstream", code: "3043" });
  assert.deepEqual(classifyTtsError({ code: 3040 }), { transient: true, category: "upstream", code: "3040" });
  assert.deepEqual(classifyTtsError(new Error("quota reached 3036")), { transient: false, category: "quota", code: "3036" });
  assert.deepEqual(classifyTtsError(new Error("The model returned no audio."), true), { transient: false, category: "empty_audio", code: "EMPTY_AUDIO" });
  assert.equal(TTS_RETRY_DELAYS.length, 12);
});

test("TTS errors separate timeouts, unknowns, and flag-gated empty audio", () => {
  assert.deepEqual(classifyTtsError(new Error("Request timeout exceeded")), { transient: true, category: "timeout", code: null });
  assert.deepEqual(classifyTtsError(new Error("weird failure")), { transient: false, category: "unknown", code: null });
  assert.deepEqual(classifyTtsError("3040: boom"), { transient: true, category: "upstream", code: "3040" });
  assert.deepEqual(classifyTtsError(null), { transient: false, category: "unknown", code: null });
  assert.deepEqual(classifyTtsError(new Error("The model returned no audio.")), { transient: false, category: "unknown", code: null });
  assert.deepEqual(classifyTtsError(new Error("temporarily overloaded, try later")), { transient: true, category: "upstream", code: null });
  assert.deepEqual(classifyTtsError(new Error("The speech model returned truncated WAV audio.")), { transient: true, category: "upstream", code: null });
  assert.deepEqual([...TTS_TRUNCATED_RETRY_DELAYS], [2_000, 5_000, 10_000, 15_000, 20_000, 30_000]);
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

test("engine-sized chunks fit the active TTS engine input cap", () => {
  // Regression: with Aura-1 active, 3500-char chunks hit its 2000-char input
  // cap (error 8007) and fail the whole job. Chunking follows the engine.
  assert.equal(ttsChunkMax(TTS_FALLBACK_MODEL), TTS_AURA_CHUNK_MAX);
  assert.equal(ttsChunkMax(TTS_MODEL), TTS_CHUNK_MAX);
  const text = "A complete sentence for narration. ".repeat(220).trim();
  const chunks = narrationChunks(text, ttsChunkMax(TTS_FALLBACK_MODEL));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= TTS_AURA_CHUNK_MAX));
  assert.equal(chunks.join(" "), text);
});

test("WAV assembly accepts streamed audio with an unknown data size", () => {
  // Streaming encoders mark the data chunk with an unknown-size sentinel
  // instead of the real length. The payload on the wire is complete; only
  // the declared size is a placeholder.
  for (const sentinel of [0xFFFFFFFF, 0x7FFF0000]) {
    const streamed = wav(new Uint8Array([1, 2, 3, 4]));
    new DataView(streamed.buffer).setUint32(40, sentinel, true);
    const assembly = wavAssembly([streamed], 0);
    assert.equal(assembly.size, 44 + 4);
    assert.deepEqual([...assembly.samples[0]], [1, 2, 3, 4]);
    assert.equal(new DataView(assembly.header.buffer).getUint32(40, true), 4);
  }
});

test("segment audio validation gates checkpoints on complete WAV", () => {
  assert.equal(validWavAudio(wav(new Uint8Array([1, 2]))), true);
  const streamed = wav(new Uint8Array([1, 2]));
  new DataView(streamed.buffer).setUint32(40, 0xFFFFFFFF, true);
  assert.equal(validWavAudio(streamed), true);
  const short = wav(new Uint8Array([1, 2]));
  new DataView(short.buffer).setUint32(40, 100, true);
  assert.equal(validWavAudio(short), false);
  assert.equal(validWavAudio(new Uint8Array([1, 2, 3])), false);
});

test("WAV assembly still rejects a concretely short data chunk", () => {
  const short = wav(new Uint8Array([1, 2]));
  new DataView(short.buffer).setUint32(40, 100, true);
  assert.throws(() => wavAssembly([short], 0), /truncated WAV audio/);
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

test("WAV assembly uses midpoint silence for unsigned 8-bit PCM", () => {
  const eight = (samples) => {
    const bytes = wav(samples);
    new DataView(bytes.buffer).setUint16(34, 8, true);
    return bytes;
  };
  const assembly = wavAssembly(
    [eight(new Uint8Array([9, 9])), eight(new Uint8Array([7, 7]))],
    [0.65, 0],
  );
  assert.equal(assembly.samples[1].length, 31_200);
  assert.ok(assembly.samples[1].every((byte) => byte === 128));
  assert.deepEqual([...assembly.samples[0]], [9, 9]);
  assert.deepEqual([...assembly.samples[2]], [7, 7]);
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
  assert.match(index, /app\.delete\("\/api\/v1\/blogs\/:blogId\/posts\/:id\/audio"/);
  assert.match(index, /UPDATE posts SET audio_key = NULL/);
  assert.match(index, /c\.env\.MEDIA\.delete\(post\.audio_key\)/);
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
  assert.match(index, /depth < 3 && prompt\.length >= 120/);
  assert.match(index, /if \(!validWavAudio\(bytes\)\) throw new Error\("The speech model returned truncated WAV audio\."\);/);
  assert.match(index, /if \(!validWavAudio\(fresh\)\) throw new Error\("The speech model returned truncated WAV audio\."\);/);
  assert.match(index, /Drop the\n\s+\/\/ poison and resynthesize/);
  assert.match(index, /Segment \$\{job\.completed \+ 1\} of \$\{job\.prompts\.length\} \(\$\{failing\.text\.length\} chars\): \$\{detail\}/);
  assert.match(index, /classifyTtsError\(error\)\.transient/);
  assert.match(index, /Workers AI narration quota reached \(3036\)/);
  assert.match(index, /delays\[attempt\]/);
  assert.match(index, /starting slower second wind/);
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

test("narration skips a trailing sources credit block", () => {
  const sections = narrationSections(
    "AI and institutions",
    "Closing thought on power.\n\n---\n\nSources:\n\n- Jane Marple, [*How AI Destroys Institutions*](https://example.com/paper), 77 UC Law Journal (2026).\n- John Smith, [*A Response*](https://example.com/response).",
  );
  assert.match(sections.body, /Closing thought on power/);
  assert.doesNotMatch(sections.body, /Sources/);
  assert.doesNotMatch(sections.body, /Marple/);
  assert.doesNotMatch(sections.body, /example\.com/);
});

test("narration skips an ATX sources heading variant", () => {
  const sections = narrationSections(
    "AI and institutions",
    "Closing thought on power.\n\n## Sources\n\n- Jane Marple, How AI Destroys Institutions.",
  );
  assert.match(sections.body, /Closing thought on power/);
  assert.doesNotMatch(sections.body, /Sources/);
  assert.doesNotMatch(sections.body, /Marple/);
});

test("narration keeps a sources mention followed by real prose", () => {
  const sections = narrationSections(
    "AI and institutions",
    "Opening line.\n\nSources\n\nThis paragraph continues the article with genuine analysis that runs well beyond two hundred characters so the cutter knows real prose follows the marker and nothing may be dropped from the narration at all.",
  );
  assert.match(sections.body, /Opening line/);
  assert.match(sections.body, /genuine analysis/);
  assert.match(sections.body, /Sources/);
});

test("audio queue failures answer JSON, refund, and never rethrow (source checks)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /Speech synthesis is temporarily unavailable — no credits were used/);
  assert.match(src, /audio reservation refund failed/);
  assert.match(src, /return c\.json\(\{ error: message \}, 409\)/);
  assert.doesNotMatch(src, /await refundAiCredits\(c\.env, audioReservation\.accountId, audioReservation\.period, audioCost\);\n    throw error;/);
});

test("audio editor parses responses defensively instead of blind json() (source checks)", () => {
  const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.match(admin, /function readJsonResponse\(r\)/);
  assert.match(admin, /Server error \(" \+ r\.status \+ "\)\. Please try again\./);
  const audioFetches = admin.match(/"\$\{base\}\/audio\/" \+ \(currentPostId \|\| ""\)[^;]*?\.then\(readJsonResponse\)/g) || [];
  assert.ok(audioFetches.length >= 3, `expected 3 audio fetches via readJsonResponse, got ${audioFetches.length}`);
});

test("engine switch selects MeloTTS by default and Aura-1 only when set", async () => {
  const { selectTtsEngine, TTS_MODEL, TTS_FALLBACK_MODEL } = await import("../src/tts.ts");
  assert.equal(TTS_FALLBACK_MODEL, "@cf/deepgram/aura-1");
  assert.equal(selectTtsEngine(undefined), TTS_MODEL);
  assert.equal(selectTtsEngine(null), TTS_MODEL);
  assert.equal(selectTtsEngine(""), TTS_MODEL);
  assert.equal(selectTtsEngine("melotts"), TTS_MODEL);
  assert.equal(selectTtsEngine("aura-1"), TTS_FALLBACK_MODEL);
  assert.equal(selectTtsEngine("bogus"), TTS_MODEL);
});

test("speech generation routes by engine model and consumes Aura streams", async () => {
  const { generateSpeechForModel } = await import("../src/index.ts");
  const { TTS_MODEL, TTS_FALLBACK_MODEL } = await import("../src/tts.ts");
  const calls = [];
  const auraWav = wav(new Uint8Array([1, 2, 3]));
  const meloWav = wav(new Uint8Array([9, 8]));
  const fakeAi = {
    run: async (model, input) => {
      calls.push({ model, input });
      if (String(model).includes("aura")) {
        return new ReadableStream({ start(c) { c.enqueue(auraWav); c.close(); } });
      }
      return meloWav;
    },
  };
  const melo = await generateSpeechForModel(fakeAi, TTS_MODEL, "hello");
  assert.deepEqual([...melo], [...meloWav]);
  assert.equal(calls[0].model, TTS_MODEL);
  assert.deepEqual(calls[0].input, { prompt: "hello", lang: "en" });
  const aura = await generateSpeechForModel(fakeAi, TTS_FALLBACK_MODEL, "hello");
  assert.deepEqual([...aura], [...auraWav]);
  assert.equal(calls[1].model, TTS_FALLBACK_MODEL);
  assert.equal(calls[1].input.encoding, "linear16");
  assert.equal(calls[1].input.container, "wav");
  await assert.rejects(generateSpeechForModel({ run: async () => new Uint8Array() }, TTS_FALLBACK_MODEL, "x"), /no audio/);
  const cut = wav(new Uint8Array([1, 2]));
  new DataView(cut.buffer).setUint32(40, 100, true);
  await assert.rejects(
    generateSpeechForModel({ run: async () => new ReadableStream({ start(c) { c.enqueue(cut); c.close(); } }) }, TTS_FALLBACK_MODEL, "x"),
    /truncated WAV audio/,
  );
});

test("audio jobs record the selected engine and render on it (source checks)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /model\?: string;/);
  assert.match(src, /selectTtsEngine\(await readTtsEngineSetting\((c\.env\.DB|env\.DB)\)\)/);
  assert.match(src, /generateSpeechWithRecovery\(env\.AI, job\.prompts\[index\]\.text, 0, job\.model/);
  assert.match(src, /checkpointHash = await sha256hex\(`\$\{[^`]*jobModel[^`]*\}`\)/);
  assert.match(src, /generatedBy: job\.model \?\? TTS_MODEL/);
  assert.match(src, /voice\?: string \| null;/);
  assert.match(src, /selectTtsVoice\(await readTtsVoiceSetting\((c\.env\.DB|env\.DB)\)\)/);
  assert.match(src, /job\.model[^)]*job\.voice \?\? null/);
  assert.match(src, /checkpointHash = await sha256hex\(`\$\{[^`]*jobVoice[^`]*\}`\)/);
});

test("aura voice selection fails closed to luna and reaches the synthesis input", async () => {
  const { selectTtsVoice, TTS_FALLBACK_MODEL } = await import("../src/tts.ts");
  assert.equal(selectTtsVoice("asteria"), "asteria");
  assert.equal(selectTtsVoice("luna"), "luna");
  assert.equal(selectTtsVoice(null), "luna");
  assert.equal(selectTtsVoice("bogus-voice"), "luna");
  const { generateSpeechForModel } = await import("../src/index.ts");
  const seen = [];
  const ok = wav(new Uint8Array([1, 2, 3]));
  const fakeAi = {
    run: async (model, input) => {
      seen.push({ model, input });
      return new ReadableStream({ start(c) { c.enqueue(ok); c.close(); } });
    },
  };
  await generateSpeechForModel(fakeAi, TTS_FALLBACK_MODEL, "hello", "asteria");
  assert.equal(seen[0].input.speaker, "asteria");
  await generateSpeechForModel(fakeAi, TTS_FALLBACK_MODEL, "hello", "luna");
  assert.equal(seen[1].input.speaker, "luna");
  await generateSpeechForModel(fakeAi, TTS_FALLBACK_MODEL, "hello", null);
  assert.ok(!("speaker" in seen[2].input), "null voice keeps the provider default");
});
