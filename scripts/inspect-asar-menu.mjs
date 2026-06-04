#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readAsarHeader(data, asarPath) {
  const headerSize = data.readUInt32LE(4);
  const headerPickle = data.subarray(8, 8 + headerSize);
  const headerStringSize = headerPickle.readInt32LE(4);
  const headerString = headerPickle.subarray(8, 8 + headerStringSize).toString("utf8");
  return { headerSize, header: JSON.parse(headerString) };
}

function walkAsarFiles(node, prefix = "", results = []) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walkAsarFiles(child, prefix ? `${prefix}/${name}` : name, results);
    }
  } else if ("offset" in node) {
    results.push([prefix, node]);
  }
  return results;
}

const asarPath =
  process.argv[2] ||
  "C:/Users/Administrator/.codex/zh-cn-patched/ce42a6517f98f667/app/resources/app.asar";
const needles = (process.argv[3] || "editMenu,Toggle Bottom,windowMenu,About,Featured,Bundled,Computer Use")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const data = fs.readFileSync(asarPath);
const { headerSize, header } = readAsarHeader(data, asarPath);
let mainPath = null;
for (const [filePath] of walkAsarFiles(header)) {
  if (filePath.includes(".vite/build/main-") && filePath.endsWith(".js")) {
    mainPath = filePath;
    break;
  }
}
if (!mainPath) throw new Error("main bundle not found");
const entry = walkAsarFiles(header).find(([p]) => p === mainPath)[1];
const offset = 8 + headerSize + Number(entry.offset);
const content = data.subarray(offset, offset + Number(entry.size)).toString("utf8");

console.log("main:", mainPath, "size:", entry.size);
for (const needle of needles) {
  let idx = 0;
  let c = 0;
  while ((idx = content.indexOf(needle, idx + 1)) >= 0 && c < 3) {
    console.log(
      `\n--- ${needle} @ ${idx} ---\n`,
      content.substring(Math.max(0, idx - 120), idx + 200)
    );
    c++;
  }
  if (c === 0) console.log(`\n--- ${needle}: NOT FOUND ---`);
}
