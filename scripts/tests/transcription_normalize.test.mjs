import assert from "node:assert/strict";
import normalizeModule from "../../extension/transcription/normalize.js";
const { normalizeTranscriptionSegments } = normalizeModule;

const whisperVerboseJson = {
  language: "zh",
  segments: [
    { start: 0, end: 1.8, text: "  大家好  " },
    { start: 1.8, end: 4.2, text: "欢迎来到这个视频" },
    { start: 4.2, end: 4.2, text: "" }
  ]
};

assert.deepEqual(normalizeTranscriptionSegments(whisperVerboseJson, 10), [
  { from: 0, to: 1.8, content: "大家好" },
  { from: 1.8, to: 4.2, content: "欢迎来到这个视频" }
]);

const localServiceShape = {
  segments: [
    { from: 2, content: "第一句" },
    { from: 5, content: "第二句" }
  ]
};

assert.deepEqual(normalizeTranscriptionSegments(localServiceShape, 8), [
  { from: 2, to: 5, content: "第一句" },
  { from: 5, to: 8, content: "第二句" }
]);

assert.deepEqual(normalizeTranscriptionSegments({ text: "只有全文，没有分段" }, 9), [
  { from: 0, to: 9, content: "只有全文，没有分段" }
]);

assert.throws(
  () => normalizeTranscriptionSegments({ segments: [{ start: 99, end: 120, text: "错位" }] }, 10),
  /exceeds video duration/
);

console.log("transcription normalize tests passed");