#!/usr/bin/env node
import fs from "node:fs";

function readAsarHeader(data) {
  const headerSize = data.readUInt32LE(4);
  const headerPickle = data.subarray(8, 8 + headerSize);
  const headerStringSize = headerPickle.readInt32LE(4);
  const headerString = headerPickle
    .subarray(8, 8 + headerStringSize)
    .toString("utf8");
  return { headerSize, header: JSON.parse(headerString) };
}

function walkAsarFiles(node, prefix = "", results = []) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walkAsarFiles(child, prefix ? `${prefix}/${name}` : name, results);
    }
  } else if ("offset" in node) results.push([prefix, node]);
  return results;
}

const asarPath =
  process.argv[2] ||
  "C:/Users/Administrator/.codex/zh-cn-patched/ce42a6517f98f667/app/resources/app.asar";
const needles = (process.argv[3] || "Featured,OpenAI Bundled,Toggle Bottom,Computer Use,Spreadsheets,Presentations,toggleBottomPanel")
  .split(",")
  .map((s) => s.trim());

const data = fs.readFileSync(asarPath);
const { headerSize, header } = readAsarHeader(data);
const zhPath = walkAsarFiles(header).find(
  ([p]) => p.includes("webview/assets/zh-CN-") && p.endsWith(".js")
)?.[0];
if (!zhPath) throw new Error("zh-CN bundle missing");
const entry = getEntry(header, zhPath);
const content = data
  .subarray(8 + headerSize + Number(entry.offset), 8 + headerSize + Number(entry.offset) + Number(entry.size))
  .toString("utf8");

console.log("zh:", zhPath);
for (const needle of needles) {
  const has = content.includes(needle);
  console.log(needle, has ? "YES" : "no");
  if (has) {
    const idx = content.indexOf(needle);
    console.log(content.substring(Math.max(0, idx - 60), idx + 80));
  }
}

function getEntry(header, filePath) {
  let node = header;
  for (const part of filePath.split("/")) node = node.files[part];
  return node;
}
