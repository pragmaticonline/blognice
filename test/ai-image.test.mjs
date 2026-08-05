import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AI_BRIEF_MODEL,
  AI_IMAGE_MODEL,
  AI_IMAGE_PROMPT_MAX,
  buildFallbackBrief,
  buildImagePrompt,
  buildSourceContext,
} from "../src/ai-image.ts";

test("post source context prioritizes the title and stays bounded", () => {
  const source = buildSourceContext({
    prompt: "",
    mode: "post",
    blogTitle: "Example",
    postTitle: "A wide world",
    postBody: "Body ".repeat(5000),
  });
  assert.match(source, /POST TITLE — PRIMARY SUBJECT: A wide world/);
  assert.ok(source.indexOf("A wide world") < source.indexOf("Body Body"));
  assert.ok(source.length <= 12_000);
});

test("whole-blog source context contains blog identity and post themes", () => {
  const source = buildSourceContext({
    mode: "blog",
    blogTitle: "Field Notes",
    blogDescription: "Ideas from the road",
    blogPosts: [{ title: "Bangkok", body_md: "Markets and city life" }],
  });
  assert.match(source, /Field Notes/);
  assert.match(source, /Bangkok/);
});

test("final image prompt uses wide framing without inviting generic scenery", () => {
  const prompt = buildImagePrompt("A portrait of a watchmaker at work", "editorial-photo");
  assert.match(prompt, /Subject and action/);
  assert.match(prompt, /16:9 horizontal editorial thumbnail/);
  assert.match(prompt, /natural-light editorial photograph/);
  assert.match(prompt, /lettering, or readable words/);
  assert.match(prompt, /browser window, website, article page/);
  assert.doesNotMatch(prompt, /Landscape composition/);
  assert.ok(prompt.length <= AI_IMAGE_PROMPT_MAX);
});

test("creative direction can replace the post context", () => {
  const source = buildSourceContext({
    prompt: "A surreal red telephone booth in a flooded library",
    mode: "prompt",
    blogTitle: "Example",
    postTitle: "A post title that must not leak into the override",
    postBody: "Post body that must not leak into the override",
  });
  assert.match(source, /AUTHOR DIRECTION/);
  assert.doesNotMatch(source, /must not leak/);
});

test("fallback brief preserves source meaning when the text model fails", () => {
  assert.match(buildFallbackBrief("POST TITLE — PRIMARY SUBJECT: Local democracy"), /Local democracy/);
});

test("one-click generation chains both models and saves to the media bucket", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const admin = readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
  assert.equal(AI_BRIEF_MODEL, "@cf/ibm-granite/granite-4.0-h-micro");
  assert.equal(AI_IMAGE_MODEL, "@cf/black-forest-labs/flux-2-klein-4b");
  assert.match(index, /env\.AI\.run\(AI_BRIEF_MODEL/);
  assert.match(index, /runFlux2Klein\(env\.AI, prompt\)/);
  assert.match(index, /form\.append\("width", "1024"\)/);
  assert.match(index, /form\.append\("height", "576"\)/);
  assert.match(index, /const visualBrief = await createVisualBrief/);
  assert.match(index, /env\.MEDIA\.put\(key, bytes/);
  assert.match(index, /\/api\/v1\/blogs\/:blogId\/images\/generations/);
  assert.match(index, /\/api\/v1\/blogs\/:blogId\/posts\/:id\/audio\/generations/);
  assert.match(index, /processImageJob\(env, jobMessage\.jobKey\)/);
  assert.match(index, /status_url/);
  assert.match(admin, /id="ai-generate"/);
  assert.doesNotMatch(admin, /id="ai-context"/);
  assert.match(admin, /child-crayon/);
  assert.doesNotMatch(admin, /id="ai-brief"/);
  assert.doesNotMatch(admin, /id="ai-create-brief"/);
  assert.match(admin, /id="ai-featured"/);
  assert.match(admin, /id="ai-insert"/);
  assert.match(admin, /!\[Generated image\]\(" \+ generatedImage\.url/);
  assert.match(admin, /generation-spinner/);
  assert.match(admin, /data-generation-seconds/);
  assert.match(admin, /Generating narration/);
});
