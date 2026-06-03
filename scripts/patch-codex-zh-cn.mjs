#!/usr/bin/env node
/**
 * Patch Codex Desktop for Simplified Chinese (zh-CN).
 * Usage:
 *   node scripts/patch-codex-zh-cn.mjs install [--codex-path PATH]
 *   node scripts/patch-codex-zh-cn.mjs uninstall [--codex-path PATH]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const resourcesDir = path.join(projectRoot, "resources");
const ASAR_BLOCK_SIZE = 4 * 1024 * 1024;

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256Range(data, offset, count) {
  return crypto.createHash("sha256").update(data.subarray(offset, offset + count)).digest("hex");
}

function readU32LE(buf, offset) {
  return buf.readUInt32LE(offset);
}

function align4(value) {
  return value + ((4 - (value % 4)) % 4);
}

function readAsarHeader(data, asarPath) {
  if (data.length < 16) throw new Error(`Unsupported app.asar header in ${asarPath}`);
  const headerSize = readU32LE(data, 4);
  if (readU32LE(data, 0) !== 4 || headerSize <= 0 || data.length < 8 + headerSize) {
    throw new Error(`Unsupported app.asar size pickle in ${asarPath}`);
  }
  const headerPickle = data.subarray(8, 8 + headerSize);
  const headerPayloadSize = readU32LE(headerPickle, 0);
  const headerStringSize = headerPickle.readInt32LE(4);
  const expectedPayloadSize = align4(4 + headerStringSize);
  if (headerPayloadSize !== expectedPayloadSize || headerSize !== 4 + headerPayloadSize) {
    throw new Error(`Unsupported app.asar header pickle in ${asarPath}`);
  }
  const headerString = headerPickle.subarray(8, 8 + headerStringSize).toString("utf8");
  return {
    headerSize,
    headerString,
    header: JSON.parse(headerString),
  };
}

function encodeAsarHeaderDynamic(headerString) {
  const headerBytes = Buffer.from(headerString, "utf8");
  const headerPayloadSize = align4(4 + headerBytes.length);
  const headerPickleSize = 4 + headerPayloadSize;
  const headerPickle = Buffer.alloc(headerPickleSize);
  headerPickle.writeUInt32LE(headerPayloadSize, 0);
  headerPickle.writeInt32LE(headerBytes.length, 4);
  headerBytes.copy(headerPickle, 8);
  const encoded = Buffer.alloc(8 + headerPickleSize);
  encoded.writeUInt32LE(4, 0);
  encoded.writeUInt32LE(headerPickleSize, 4);
  headerPickle.copy(encoded, 8);
  return encoded;
}

function walkAsarFiles(node, prefix = "", results = []) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      const next = prefix ? `${prefix}/${name}` : name;
      walkAsarFiles(child, next, results);
    }
  } else if ("offset" in node && "size" in node) {
    results.push([prefix, node]);
  }
  return results;
}

function getAsarFileEntry(header, filePath) {
  let node = header;
  for (const part of filePath.split("/")) {
    if (!node.files?.[part]) throw new Error(`Could not find ${filePath} in app.asar header.`);
    node = node.files[part];
  }
  for (const key of ["size", "offset", "integrity"]) {
    if (!(key in node)) throw new Error(`Missing ${key} for ${filePath} in app.asar header.`);
  }
  return node;
}

function getAsarFileIntegrity(data) {
  const blocks = [];
  if (data.length === 0) blocks.push(sha256(data));
  else {
    for (let offset = 0; offset < data.length; offset += ASAR_BLOCK_SIZE) {
      const count = Math.min(ASAR_BLOCK_SIZE, data.length - offset);
      blocks.push(sha256Range(data, offset, count));
    }
  }
  return {
    algorithm: "SHA256",
    hash: sha256(data),
    blockSize: ASAR_BLOCK_SIZE,
    blocks,
  };
}

function replaceAsarFileContent(asarPath, filePath, patchedContent) {
  const data = Buffer.from(fs.readFileSync(asarPath));
  const parsed = readAsarHeader(data, asarPath);
  const headerSize = parsed.headerSize;
  const header = parsed.header;
  const entry = getAsarFileEntry(header, filePath);

  const contentOffset = 8 + headerSize + Number(entry.offset);
  const contentSize = Number(entry.size);
  const contentEnd = contentOffset + contentSize;
  if (contentOffset < 0 || contentEnd > data.length) {
    throw new Error(`Unsupported app.asar file bounds for ${filePath}.`);
  }

  const oldContent = data.subarray(contentOffset, contentEnd);
  if (oldContent.equals(patchedContent)) return false;

  const targetOffset = Number(entry.offset);
  const delta = patchedContent.length - contentSize;
  entry.size = patchedContent.length;
  entry.integrity = getAsarFileIntegrity(patchedContent);

  if (delta !== 0) {
    for (const [, other] of walkAsarFiles(header)) {
      if (other !== entry && Number(other.offset) > targetOffset) {
        other.offset = String(Number(other.offset) + delta);
      }
    }
  }

  const bodyStart = 8 + headerSize;
  const before = data.subarray(bodyStart, contentOffset);
  const after = data.subarray(contentEnd);
  const body = Buffer.concat([before, patchedContent, after]);

  const updatedHeaderString = JSON.stringify(header);
  const updatedHeader = encodeAsarHeaderDynamic(updatedHeaderString);
  const updated = Buffer.concat([updatedHeader, body]);
  fs.writeFileSync(asarPath, updated);
  return true;
}

function replaceStandaloneAsarFile(asarPath, relativePath, contentBuffer) {
  return replaceAsarFileContent(asarPath, relativePath, contentBuffer);
}

function getAsarHeaderHash(asarPath) {
  const data = fs.readFileSync(asarPath);
  const parsed = readAsarHeader(data, asarPath);
  return sha256(Buffer.from(parsed.headerString, "utf8"));
}

function syncExeAsarIntegrity(codexDir, asarPath) {
  const exeCandidates = ["Codex.exe", "codex.exe"].map((name) =>
    path.join(codexDir, name)
  );
  const exePath = exeCandidates.find((p) => fs.existsSync(p));
  if (!exePath) return;

  const headerHash = getAsarHeaderHash(asarPath);
  const marker = '{"file":"resources\\\\app.asar","alg":"SHA256","value":"';
  const exeData = fs.readFileSync(exePath);
  const exeText = exeData.toString("latin1");
  const markerIndex = exeText.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(
      "Codex.exe 内未找到 app.asar 完整性标记，无法安全打补丁。请从备份恢复后重试。"
    );
  }
  const hashOffset = markerIndex + marker.length;
  const currentHash = exeText.slice(hashOffset, hashOffset + 64);
  if (currentHash === headerHash) {
    console.log("[ok] Codex.exe 完整性哈希已是最新。");
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(currentHash)) {
    throw new Error("Codex.exe app.asar integrity value is not a SHA256 hex string.");
  }

  backupFile(exePath, path.join(path.dirname(asarPath), ".zh-cn-backups", "latest"));

  const newHashBytes = Buffer.from(headerHash, "ascii");
  newHashBytes.copy(exeData, hashOffset);
  fs.writeFileSync(exePath, exeData);
  console.log(`[ok] 已更新 Codex.exe 完整性哈希: ${currentHash} -> ${headerHash}`);
}

function findCodexInstall(explicitPath) {
  if (explicitPath) {
    const resources = path.join(explicitPath, "resources");
    if (fs.existsSync(path.join(resources, "app.asar"))) {
      return { app: explicitPath, resources };
    }
    throw new Error(`未在指定路径找到 resources/app.asar: ${explicitPath}`);
  }

  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-Process Codex,codex -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path",
      ],
      { encoding: "utf8" }
    );
    const procPath = ps.stdout?.trim();
    if (procPath) {
      const app = path.dirname(procPath);
      const resources = path.join(app, "resources");
      if (fs.existsSync(path.join(resources, "app.asar"))) {
        return { app, resources };
      }
    }
  } catch {}

  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Codex"),
    "D:\\soft",
  ];
  for (const base of candidates) {
    if (!base || !fs.existsSync(base)) continue;
    if (base.endsWith("Codex") || base.endsWith("codex")) {
      const resources = path.join(base, "resources");
      if (fs.existsSync(path.join(resources, "app.asar"))) {
        return { app: base, resources };
      }
    }
    const dirs = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /Codex-win/i.test(d.name))
      .map((d) => path.join(base, d.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const dir of dirs) {
      const resources = path.join(dir, "resources");
      if (fs.existsSync(path.join(resources, "app.asar"))) {
        return { app: dir, resources };
      }
    }
  }
  throw new Error("未找到 Codex Desktop 安装目录。请使用 --codex-path 指定。");
}

function stopCodex() {
  console.log("[info] 正在关闭 Codex…");
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Stop-Process -Name Codex,codex -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2",
    ],
    { encoding: "utf8", timeout: 15000 }
  );
  if (result.error?.code === "ETIMEDOUT") {
    console.log("[warn] 关闭 Codex 超时，继续安装。");
  }
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(resourcesDir, name), "utf8"));
}

const ROLE_MENU_PATCHES = [
  [
    "{role:`editMenu`,id:e.bn.edit}",
    "{label:`编辑`,id:e.bn.edit,submenu:[{role:`undo`,label:`撤销`},{role:`redo`,label:`重做`},{type:`separator`},{role:`cut`,label:`剪切`},{role:`copy`,label:`复制`},{role:`paste`,label:`粘贴`},{role:`delete`,label:`删除`},{type:`separator`},{role:`selectAll`,label:`全选`}]}",
  ],
  [
    "{role:`windowMenu`,id:e.bn.window}",
    "{label:`窗口`,id:e.bn.window,submenu:[{role:`minimize`,label:`最小化`},{role:`zoom`,label:`缩放`},{type:`separator`},{role:`close`,label:`关闭`}]}",
  ],
  [
    "About ${n.app.getName()}",
    "关于 ${n.app.getName()}",
  ],
  [
    "title:`About ${e}`",
    "title:`关于 ${e}`",
  ],
  [
    "{role:`quit`}",
    "{role:`quit`,label:`退出`}",
  ],
  [
    "??`Quit ${e}`",
    "??`退出 ${e}`",
  ],
];

function patchRoleMenus(content) {
  let text = content.toString("utf8");
  let count = 0;
  for (const [source, target] of ROLE_MENU_PATCHES) {
    if (!text.includes(source)) continue;
    const matches = text.split(source).length - 1;
    text = text.replaceAll(source, target);
    count += matches;
  }
  return { buffer: Buffer.from(text, "utf8"), count };
}

function patchMainBundle(content, pairs) {
  let text = content.toString("utf8");
  let count = 0;
  for (const [source, target] of pairs) {
    const pattern = `(?<quote>[\`"'])${escapeRegExp(source)}\\k<quote>`;
    const re = new RegExp(pattern, "g");
    const before = text;
    text = text.replace(re, (_m, quote) => {
      count += 1;
      return `${quote}${target}${quote}`;
    });
    if (text === before) {
      const labelPattern = `label:\`${escapeRegExp(source)}\``;
      const labelRe = new RegExp(labelPattern, "g");
      text = text.replace(labelRe, () => {
        count += 1;
        return `label:\`${target}\``;
      });
    }
  }
  return { buffer: Buffer.from(text, "utf8"), count };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patchZhBundle(content, menuTitleMap) {
  let text = content.toString("utf8");
  const additions = [];
  for (const [key, value] of Object.entries(menuTitleMap)) {
    if (text.includes(`"${key}":`)) continue;
    additions.push(`"${key}":\`${value.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``);
  }
  if (additions.length === 0) return { buffer: content, count: 0 };
  const insertAt = text.lastIndexOf("};export");
  if (insertAt < 0) throw new Error("无法定位 zh-CN bundle 导出位置。");
  const prefix = additions.length > 0 ? "," : "";
  text =
    text.slice(0, insertAt) +
    prefix +
    additions.join(",") +
    text.slice(insertAt);
  return { buffer: Buffer.from(text, "utf8"), count: additions.length };
}

function setCodexLocale() {
  const codexHome = path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });

  let content = fs.existsSync(configPath)
    ? fs.readFileSync(configPath, "utf8")
    : "";
  const block = `[desktop]\nlocaleOverride = "zh-CN"\n`;
  if (/^\[desktop\]/m.test(content)) {
    if (/localeOverride\s*=/.test(content)) {
      content = content.replace(
        /localeOverride\s*=\s*"[^"]*"/,
        'localeOverride = "zh-CN"'
      );
    } else {
      content = content.replace(/\[desktop\]\s*\n?/, block);
    }
  } else {
    content = `${content.trimEnd()}\n\n${block}`;
  }
  fs.writeFileSync(configPath, content, "utf8");
  console.log(`[ok] 已写入 ${configPath}`);
}

function restoreCodexLocale() {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  if (!fs.existsSync(configPath)) return;
  let content = fs.readFileSync(configPath, "utf8");
  content = content.replace(/localeOverride\s*=\s*"zh-CN"/, 'localeOverride = "en-US"');
  fs.writeFileSync(configPath, content, "utf8");
  console.log(`[ok] 已恢复语言配置 ${configPath}`);
}

function backupFile(filePath, backupRoot) {
  if (!fs.existsSync(filePath)) return;
  const rel = path.basename(filePath);
  const target = path.join(backupRoot, rel);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.copyFileSync(filePath, target);
    console.log(`[backup] ${rel}`);
  }
}

function restoreBackup(backupRoot, targetDir, fileName) {
  const source = path.join(backupRoot, fileName);
  const target = path.join(targetDir, fileName);
  if (!fs.existsSync(source)) return false;
  fs.copyFileSync(source, target);
  console.log(`[restore] ${fileName}`);
  return true;
}

function getCodexHome() {
  return path.join(os.homedir(), ".codex");
}

function getPluginBackupRoot(codexHome) {
  return path.join(codexHome, ".zh-cn-backups", "latest");
}

function findBundledPluginJsonFiles(codexHome) {
  const results = new Set();
  const roots = [
    path.join(codexHome, "plugins", "cache", "openai-bundled"),
    path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins"),
  ];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".codex-plugin") {
          const pluginJson = path.join(next, "plugin.json");
          if (fs.existsSync(pluginJson)) results.add(pluginJson);
          continue;
        }
        walk(next);
      }
    }
  }

  for (const root of roots) walk(root);
  return [...results];
}

function backupPluginJson(pluginJsonPath, backupRoot, codexHome) {
  const rel = path.relative(codexHome, pluginJsonPath);
  const target = path.join(backupRoot, rel);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(pluginJsonPath, target);
  console.log(`[backup] ${rel}`);
}

function patchPluginInterface(pluginJsonPath, translations) {
  const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  const patch = translations[plugin.name];
  if (!patch || !plugin.interface) return false;

  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) {
      if (JSON.stringify(plugin.interface[key]) !== JSON.stringify(value)) {
        plugin.interface[key] = value;
        changed = true;
      }
      continue;
    }
    if (typeof value === "string" && plugin.interface[key] !== value) {
      plugin.interface[key] = value;
      changed = true;
    }
  }
  if (!changed) return false;

  fs.writeFileSync(pluginJsonPath, `${JSON.stringify(plugin, null, 2)}\n`, "utf8");
  return true;
}

function patchBundledPlugins(translations) {
  const codexHome = getCodexHome();
  const backupRoot = getPluginBackupRoot(codexHome);
  const pluginJsonPaths = findBundledPluginJsonFiles(codexHome);
  if (pluginJsonPaths.length === 0) {
    console.log("[warn] 未找到内置插件 plugin.json，请先启动一次 Codex 后再安装。");
    return 0;
  }

  let count = 0;
  for (const pluginJsonPath of pluginJsonPaths) {
    backupPluginJson(pluginJsonPath, backupRoot, codexHome);
    if (patchPluginInterface(pluginJsonPath, translations)) {
      count += 1;
      console.log(`[ok] 已汉化插件 ${path.relative(codexHome, pluginJsonPath)}`);
    }
  }
  return count;
}

function restoreBundledPlugins() {
  const codexHome = getCodexHome();
  const backupRoot = getPluginBackupRoot(codexHome);
  if (!fs.existsSync(backupRoot)) return 0;

  let count = 0;
  function walk(dir, rel = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const nextAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(nextAbs, nextRel);
        continue;
      }
      if (entry.name !== "plugin.json") continue;
      const target = path.join(codexHome, nextRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(nextAbs, target);
      console.log(`[restore] ${nextRel}`);
      count += 1;
    }
  }

  walk(backupRoot);
  return count;
}

function install(options) {
  const installInfo = findCodexInstall(options.codexPath);
  const { app, resources } = installInfo;
  const asarPath = path.join(resources, "app.asar");
  const backupRoot = path.join(resources, ".zh-cn-backups", "latest");

  console.log(`[info] Codex 目录: ${app}`);
  stopCodex();

  backupFile(asarPath, backupRoot);
  backupFile(path.join(app, "Codex.exe"), backupRoot);

  const nativeMenu = loadJson("native-menu-zh-CN.json");
  const hardcoded = loadJson("menu-hardcoded-zh-CN.json");

  replaceStandaloneAsarFile(
    asarPath,
    "native-menu-locales/zh-CN.json",
    Buffer.from(JSON.stringify(nativeMenu), "utf8")
  );
  console.log("[ok] 已更新 native-menu-locales/zh-CN.json");

  const parsed = readAsarHeader(fs.readFileSync(asarPath), asarPath);
  const headerSize = parsed.headerSize;
  let mainAsarPath = null;
  for (const [filePath] of walkAsarFiles(parsed.header)) {
    if (filePath.includes(".vite/build/main-") && filePath.endsWith(".js")) {
      mainAsarPath = filePath;
      break;
    }
  }
  if (!mainAsarPath) throw new Error("未在 app.asar 中找到 main bundle。");

  const data = fs.readFileSync(asarPath);
  const entry = getAsarFileEntry(parsed.header, mainAsarPath);
  const offset = 8 + headerSize + Number(entry.offset);
  const mainContent = data.subarray(offset, offset + Number(entry.size));
  const mainPatched = patchMainBundle(mainContent, hardcoded);
  const rolePatched = patchRoleMenus(mainPatched.buffer);
  replaceAsarFileContent(asarPath, mainAsarPath, rolePatched.buffer);
  console.log(
    `[ok] 已汉化主进程菜单：硬编码 ${mainPatched.count} 处，结构/角色 ${rolePatched.count} 处 (${mainAsarPath})`
  );

  let zhAsarPath = null;
  for (const [filePath] of walkAsarFiles(parsed.header)) {
    if (filePath.includes("webview/assets/zh-CN-") && filePath.endsWith(".js")) {
      zhAsarPath = filePath;
      break;
    }
  }
  if (zhAsarPath) {
    const parsed3 = readAsarHeader(fs.readFileSync(asarPath), asarPath);
    const entry2 = getAsarFileEntry(parsed3.header, zhAsarPath);
    const offset2 = 8 + parsed3.headerSize + Number(entry2.offset);
    const zhContent = fs.readFileSync(asarPath).subarray(offset2, offset2 + Number(entry2.size));
    const menuTitleMap = Object.fromEntries(
      Object.entries(nativeMenu).filter(([k]) => k.startsWith("codex.commandMenuTitle."))
    );
    const zhPatched = patchZhBundle(zhContent, menuTitleMap);
    if (zhPatched.count > 0) {
      replaceAsarFileContent(asarPath, zhAsarPath, zhPatched.buffer);
      console.log(`[ok] 已补充 webview 中文词条 ${zhPatched.count} 条 (${zhAsarPath})`);
    }
  }

  syncExeAsarIntegrity(app, asarPath);
  setCodexLocale();

  const bundledPlugins = loadJson("bundled-plugins-zh-CN.json");
  const pluginCount = patchBundledPlugins(bundledPlugins);
  if (pluginCount > 0) {
    console.log(`[ok] 已汉化内置插件 metadata ${pluginCount} 处`);
  }

  console.log(`[codex-app] ${app}`);
  console.log("[ok] 汉化补丁已写入，请重新启动 Codex Desktop。");
}

function uninstall(options) {
  const installInfo = findCodexInstall(options.codexPath);
  const { app, resources } = installInfo;
  const asarPath = path.join(resources, "app.asar");
  const backupRoot = path.join(resources, ".zh-cn-backups", "latest");

  stopCodex();
  if (restoreBackup(backupRoot, resources, "app.asar")) {
    syncExeAsarIntegrity(app, asarPath);
  }
  restoreBackup(backupRoot, app, "Codex.exe");
  const exeBackup = path.join(backupRoot, "Codex.exe");
  if (fs.existsSync(exeBackup)) {
    fs.copyFileSync(exeBackup, path.join(app, "Codex.exe"));
    console.log("[restore] Codex.exe");
  }
  restoreCodexLocale();
  const restoredPlugins = restoreBundledPlugins();
  if (restoredPlugins > 0) {
    console.log(`[ok] 已恢复 ${restoredPlugins} 个插件 metadata 文件`);
  }
  console.log("[ok] 已恢复原样。");
}

function isCodexRunning() {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "(Get-Process Codex,codex -ErrorAction SilentlyContinue | Measure-Object).Count",
    ],
    { encoding: "utf8", timeout: 10000 }
  );
  const count = Number.parseInt(result.stdout?.trim() || "0", 10);
  return Number.isFinite(count) && count > 0;
}

function isAsarLocalized(asarPath) {
  try {
    const content = fs.readFileSync(asarPath).toString("utf8");
    return (
      content.includes("label:`文件`") &&
      content.includes("关于 ${n.app.getName()}") &&
      content.includes("label:`撤销`")
    );
  } catch {
    return false;
  }
}

function getLocaleOverride() {
  const configPath = path.join(getCodexHome(), "config.toml");
  if (!fs.existsSync(configPath)) return null;
  const match = fs.readFileSync(configPath, "utf8").match(/localeOverride\s*=\s*"([^"]*)"/);
  return match ? match[1] : null;
}

function getPluginLocalizationSummary(translations) {
  const pluginJsonPaths = findBundledPluginJsonFiles(getCodexHome());
  let localized = 0;
  let total = 0;
  const details = [];

  for (const pluginJsonPath of pluginJsonPaths) {
    const plugin = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
    const expected = translations[plugin.name];
    if (!expected || !plugin.interface) continue;
    total += 1;
    const ok = expected.displayName
      ? plugin.interface.displayName === expected.displayName
      : true;
    if (ok) localized += 1;
    details.push({
      name: plugin.name,
      path: path.relative(getCodexHome(), pluginJsonPath),
      localized: ok,
      displayName: plugin.interface.displayName || "",
    });
  }

  return { localized, total, details };
}

function buildStatusReport(options) {
  const translations = loadJson("bundled-plugins-zh-CN.json");
  const report = {
    ok: true,
    nodeVersion: process.version,
    nodeOk: true,
    codexPath: null,
    codexFound: false,
    codexRunning: isCodexRunning(),
    asarPath: null,
    asarBackup: false,
    asarLocalized: false,
    exeBackup: false,
    localeOverride: getLocaleOverride(),
    localeZhCn: false,
    pluginsLocalized: 0,
    pluginsTotal: 0,
    plugins: [],
    patchInstalled: false,
    readyToInstall: true,
    messages: [],
  };

  try {
    const installInfo = findCodexInstall(options.codexPath);
    report.codexFound = true;
    report.codexPath = installInfo.app;
    report.asarPath = path.join(installInfo.resources, "app.asar");
    const backupRoot = path.join(installInfo.resources, ".zh-cn-backups", "latest");
    report.asarBackup = fs.existsSync(path.join(backupRoot, "app.asar"));
    report.exeBackup = fs.existsSync(path.join(backupRoot, "Codex.exe"));
    report.asarLocalized = isAsarLocalized(report.asarPath);
  } catch (error) {
    report.ok = false;
    report.readyToInstall = false;
    report.messages.push(error.message);
  }

  report.localeZhCn = report.localeOverride === "zh-CN";
  const pluginSummary = getPluginLocalizationSummary(translations);
  report.pluginsLocalized = pluginSummary.localized;
  report.pluginsTotal = pluginSummary.total;
  report.plugins = pluginSummary.details;
  report.patchInstalled =
    report.asarLocalized &&
    report.localeZhCn &&
    (report.pluginsTotal === 0 || report.pluginsLocalized === report.pluginsTotal);

  if (!report.codexRunning && report.codexFound) {
    report.messages.push("Codex 当前未运行，可以直接安装或重置。");
  } else if (report.codexRunning) {
    report.messages.push("检测到 Codex 正在运行，执行汉化/重置前会自动尝试关闭。");
  }

  if (report.patchInstalled) {
    report.messages.push("当前判断：汉化已生效。");
  } else if (report.codexFound) {
    report.messages.push("当前判断：尚未完全汉化，或 Codex 更新后需要重新安装。");
  }

  if (report.pluginsTotal === 0 && report.codexFound) {
    report.messages.push("尚未找到内置插件缓存，首次汉化前建议先启动一次 Codex。");
  }

  return report;
}

function printStatusReport(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify(report));
    return;
  }

  console.log("[env] nodeVersion=" + report.nodeVersion);
  console.log("[env] codexFound=" + report.codexFound);
  console.log("[env] codexPath=" + (report.codexPath || ""));
  console.log("[env] codexRunning=" + report.codexRunning);
  console.log("[env] asarLocalized=" + report.asarLocalized);
  console.log("[env] asarBackup=" + report.asarBackup);
  console.log("[env] exeBackup=" + report.exeBackup);
  console.log("[env] localeOverride=" + (report.localeOverride || ""));
  console.log("[env] localeZhCn=" + report.localeZhCn);
  console.log("[env] pluginsLocalized=" + report.pluginsLocalized);
  console.log("[env] pluginsTotal=" + report.pluginsTotal);
  console.log("[env] patchInstalled=" + report.patchInstalled);
  console.log("[env] readyToInstall=" + report.readyToInstall);
  for (const message of report.messages) {
    console.log("[env-msg] " + message);
  }
  for (const plugin of report.plugins) {
    console.log(
      `[env-plugin] ${plugin.name}|${plugin.localized}|${plugin.displayName}|${plugin.path}`
    );
  }
}

function status(options) {
  const report = buildStatusReport(options);
  printStatusReport(report, options.json);
  if (!report.ok) process.exitCode = 2;
}

function parseArgs(argv) {
  const action = argv[2] || "install";
  let codexPath = null;
  let json = false;
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--codex-path" && argv[i + 1]) {
      codexPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--json") {
      json = true;
    }
  }
  return { action, codexPath, json };
}

const options = parseArgs(process.argv);
try {
  if (options.action === "status") status(options);
  else if (options.action === "uninstall") uninstall(options);
  else if (options.action === "install") install(options);
  else throw new Error(`未知操作: ${options.action}`);
} catch (error) {
  console.error(`[error] ${error.message}`);
  process.exit(1);
}
