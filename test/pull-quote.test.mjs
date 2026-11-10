import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderMarkdown } from "../src/markdown.ts";

test("a leading [!pull] marker line becomes a giant-quote pull quote", () => {
  const html = renderMarkdown("> [!pull]\n>\n> Hooked at the beginning.");
  assert.match(html, /<blockquote class="pull-quote">/);
  assert.doesNotMatch(html, /\[!pull\]/);
  assert.match(html, /Hooked at the beginning/);
});

test("an inline leading [!pull] marker works and keeps the quote text", () => {
  const html = renderMarkdown("> [!pull] A great, easy read.");
  assert.match(html, /<blockquote class="pull-quote">/);
  assert.doesNotMatch(html, /\[!pull\]/);
  assert.match(html, /A great, easy read/);
});

test("plain blockquotes keep the default style without the marker class", () => {
  const html = renderMarkdown("> Just an ordinary quote.");
  assert.match(html, /<blockquote>/);
  assert.doesNotMatch(html, /pull-quote/);
});

test("a marker that is not leading does not trigger the pull-quote style", () => {
  const html = renderMarkdown("> First line.\n>\n> [!pull] Second line.");
  assert.doesNotMatch(html, /pull-quote/);
  assert.match(html, /\[!pull\] Second line/);
});

test("a marker with no quote content emits no empty pull quote", () => {
  const html = renderMarkdown("> [!pull]");
  assert.doesNotMatch(html, /pull-quote/);
});

test("the pull-quote giant-mark style exists in the prose theme", () => {
  const css = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  assert.match(css, /\.prose blockquote\.pull-quote/);
  assert.match(css, /\.prose blockquote\.pull-quote::before/);
});

test("the pull-quote style also covers pages, which render in .page-prose", () => {
  const css = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  assert.match(css, /\.page-prose blockquote\.pull-quote/);
  assert.match(css, /\.page-prose blockquote\.pull-quote::before/);
});
