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
const INSTALL_STEP_TOTAL = 8;

/** 实时输出进度（避免 PowerShell 管道缓冲时长时间无输出） */
function progressLog(step, total, message) {
  const line = `[step ${step}/${total}] ${message}`;
  console.log(line);
}

function logInfo(message) {
  console.log(`[info] ${message}`);
}

function logOk(message) {
  console.log(`[ok] ${message}`);
}

function formatProgressBar(current, total, label = "") {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const width = 30;
  const filled = Math.round((pct / 100) * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
  const short =
    label.length > 36 ? `…${label.slice(-35)}` : label;
  return `[${bar}] ${String(pct).padStart(3)}% (${current}/${total}) ${short}`.trimEnd();
}

function logProgressBar(current, total, label = "") {
  console.log(`[progress-bar] ${formatProgressBar(current, total, label)}`);
}

function runWithProgressHeartbeat(message, fn) {
  const started = Date.now();
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const sec = Math.round((Date.now() - started) / 1000);
    const spin = ["|", "/", "-", "\\"][tick % 4];
    console.log(
      `[progress-bar] [${"░".repeat(30)}] ${spin} ${message}（已等待 ${sec} 秒，请勿关闭）`
    );
  }, 2000);
  try {
    return fn();
  } finally {
    clearInterval(timer);
  }
}

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

function applyAsarBufferPatch(state, filePath, patchedContent) {
  const { data, parsed, label } = state;
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
  state.data = updated;
  state.parsed = readAsarHeader(updated, label || "app.asar");
  return true;
}

function replaceAsarFileContent(asarPath, filePath, patchedContent) {
  const data = Buffer.from(fs.readFileSync(asarPath));
  const state = {
    data,
    parsed: readAsarHeader(data, asarPath),
    label: asarPath,
  };
  if (!applyAsarBufferPatch(state, filePath, patchedContent)) return false;
  writeInstallFile(asarPath, state.data);
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

const EXE_ASAR_INTEGRITY_MARKERS = [
  '{"file":"resources\\\\app.asar","alg":"SHA256","value":"',
  '{"file":"resources\\/app.asar","alg":"SHA256","value":"',
  '{"file":"resources/app.asar","alg":"SHA256","value":"',
];

function findExeAsarIntegrityOffset(exeText) {
  for (const marker of EXE_ASAR_INTEGRITY_MARKERS) {
    const markerIndex = exeText.indexOf(marker);
    if (markerIndex >= 0) {
      return { markerIndex, marker, hashOffset: markerIndex + marker.length };
    }
  }
  return null;
}

function syncExeAsarIntegrity(codexDir, asarPath) {
  const exeCandidates = ["Codex.exe", "codex.exe"].map((name) =>
    path.join(codexDir, name)
  );
  const exePath = exeCandidates.find((p) => fs.existsSync(p));
  if (!exePath) {
    console.log("[info] 未找到 Codex.exe / codex.exe，跳过完整性哈希同步。");
    return;
  }

  const headerHash = getAsarHeaderHash(asarPath);
  const exeData = fs.readFileSync(exePath);
  const exeText = exeData.toString("latin1");
  const match = findExeAsarIntegrityOffset(exeText);
  if (!match) {
    console.log(
      `[info] ${path.basename(exePath)} 未嵌入 app.asar 完整性标记，跳过哈希同步（Microsoft Store / 新版常见）。`
    );
    return;
  }

  const { hashOffset } = match;
  const currentHash = exeText.slice(hashOffset, hashOffset + 64);
  if (currentHash === headerHash) {
    console.log(`[ok] ${path.basename(exePath)} 完整性哈希已是最新。`);
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(currentHash)) {
    console.warn(
      `[warn] ${path.basename(exePath)} 完整性字段异常，跳过哈希同步。`
    );
    return;
  }

  backupFile(exePath, getInstallBackupRoot(codexDir));

  const newHashBytes = Buffer.from(headerHash, "ascii");
  newHashBytes.copy(exeData, hashOffset);
  writeInstallFile(exePath, exeData);
  console.log(
    `[ok] 已更新 ${path.basename(exePath)} 完整性哈希: ${currentHash} -> ${headerHash}`
  );
}

function resolveCodexInstallDir(dir) {
  if (!dir) return null;
  const directAsar = path.join(dir, "resources", "app.asar");
  if (fs.existsSync(directAsar)) {
    return { app: dir, resources: path.join(dir, "resources") };
  }
  const msixApp = path.join(dir, "app");
  const msixAsar = path.join(msixApp, "resources", "app.asar");
  if (fs.existsSync(msixAsar)) {
    return { app: msixApp, resources: path.join(msixApp, "resources") };
  }
  return null;
}

const SAVED_CODEX_PATH_FILE = path.join(
  os.homedir(),
  ".codex",
  "codex-desktop-path.txt"
);

function readSavedCodexPath() {
  try {
    const value = fs.readFileSync(SAVED_CODEX_PATH_FILE, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeSavedCodexPath(dir) {
  const resolved = resolveCodexInstallDir(dir);
  if (!resolved) {
    throw new Error(`无法保存无效 Codex 路径: ${dir}`);
  }
  fs.mkdirSync(path.dirname(SAVED_CODEX_PATH_FILE), { recursive: true });
  fs.writeFileSync(SAVED_CODEX_PATH_FILE, resolved.app, "utf8");
}

function clearSavedCodexPath() {
  try {
    fs.unlinkSync(SAVED_CODEX_PATH_FILE);
  } catch {}
}

function readEnvCodexPath() {
  for (const name of ["CODEX_DESKTOP_PATH", "CODEX_ZH_CN_PATH"]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function findWindowsAppsCodex() {
  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation)",
      ],
      { encoding: "utf8" }
    );
    const installLocation = ps.stdout?.trim();
    if (installLocation) {
      const resolved = resolveCodexInstallDir(installLocation);
      if (resolved) return resolved;
    }
  } catch {}

  const windowsApps = path.join(
    process.env.ProgramFiles || "C:\\Program Files",
    "WindowsApps"
  );
  if (!fs.existsSync(windowsApps)) return null;

  let dirs = [];
  try {
    dirs = fs
      .readdirSync(windowsApps, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^OpenAI\.Codex_/i.test(d.name))
      .map((d) => path.join(windowsApps, d.name));
  } catch {
    return null;
  }

  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of dirs) {
    const resolved = resolveCodexInstallDir(dir);
    if (resolved) return resolved;
  }
  return null;
}

const CODEX_DIR_PATTERN = /^(Codex|OpenAI\.Codex)/i;

function findInParent(base, childPattern = CODEX_DIR_PATTERN) {
  if (!base || !fs.existsSync(base)) return null;
  const direct = resolveCodexInstallDir(base);
  if (direct) return direct;

  let entries = [];
  try {
    entries = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && childPattern.test(d.name))
      .map((d) => path.join(base, d.name));
  } catch {
    return null;
  }

  entries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of entries) {
    const resolved = resolveCodexInstallDir(dir);
    if (resolved) return resolved;
  }
  return null;
}

function findRegistryCodex() {
  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        [
          "$keys = @(",
          "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
          "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
          "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
          ")",
          "$locations = foreach ($key in $keys) {",
          "  Get-ItemProperty $key -ErrorAction SilentlyContinue |",
          "    Where-Object {",
          "      $_.InstallLocation -and",
          "      ($_.DisplayName -eq 'Codex' -or $_.DisplayName -match '^Codex\\s') -and",
          "      $_.DisplayName -notmatch '\\+\\+|Helper'",
          "    } |",
          "    Select-Object -ExpandProperty InstallLocation",
          "}",
          "$locations | Select-Object -Unique",
        ].join(" "),
      ],
      { encoding: "utf8" }
    );
    const lines = ps.stdout?.trim().split(/\r?\n/).filter(Boolean) || [];
    for (const loc of lines) {
      const resolved = resolveCodexInstallDir(loc.trim());
      if (resolved) return resolved;
    }
  } catch {}
  return null;
}

function getScanBases() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "";
  const userProfile = os.homedir();

  const bases = [
    path.join(localAppData, "Programs", "Codex"),
    path.join(localAppData, "Programs"),
    path.join(localAppData, "Codex"),
    path.join(programFiles, "Codex"),
    programFilesX86 ? path.join(programFilesX86, "Codex") : "",
    path.join(userProfile, "Desktop"),
    path.join(userProfile, "Downloads"),
    "D:\\soft",
    "E:\\soft",
  ];

  const seen = new Set();
  return bases.filter((base) => {
    if (!base || seen.has(base)) return false;
    seen.add(base);
    return fs.existsSync(base);
  });
}

function findCodexInstall(explicitPath) {
  if (explicitPath) {
    const resolved = resolveCodexInstallDir(explicitPath);
    if (resolved) return resolved;
    throw new Error(
      `未在指定路径找到 resources/app.asar（支持便携版目录或 MSIX 包根目录）: ${explicitPath}`
    );
  }

  for (const candidate of [
    readEnvCodexPath(),
    readSavedCodexPath(),
  ]) {
    if (!candidate) continue;
    const resolved = resolveCodexInstallDir(candidate);
    if (resolved) return resolved;
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
      let dir = path.dirname(procPath);
      for (let depth = 0; depth < 6 && dir; depth += 1) {
        const resolved = resolveCodexInstallDir(dir);
        if (resolved) return resolved;
        dir = path.dirname(dir);
      }
    }
  } catch {}

  const windowsAppsInstall = findWindowsAppsCodex();
  if (windowsAppsInstall) return windowsAppsInstall;

  const registryInstall = findRegistryCodex();
  if (registryInstall) return registryInstall;

  for (const base of getScanBases()) {
    const found = findInParent(base);
    if (found) return found;
  }

  throw new Error(
    "未找到 Codex Desktop 安装目录。请使用 --codex-path 指定，或设置环境变量 CODEX_DESKTOP_PATH。"
  );
}

const CODEX_PS_DETECT = [
  "$names = @()",
  "Get-Process -Name Codex,codex,codex-helper -ErrorAction SilentlyContinue | ForEach-Object { $names += $_.ProcessName }",
  "($names | Sort-Object -Unique) -join ','",
].join("; ");

const CODEX_PS_STOP_FAST = [
  "taskkill /F /IM codex-helper.exe /T 2>$null | Out-Null",
  "Stop-Process -Name Codex,codex,codex-helper -Force -ErrorAction SilentlyContinue",
  "taskkill /F /IM Codex.exe /T 2>$null | Out-Null",
  "taskkill /F /IM codex.exe /T 2>$null | Out-Null",
  "Start-Sleep -Seconds 1",
].join("; ");

const CODEX_PS_STOP_PATH = [
  "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
  "  $_.ExecutablePath -match 'OpenAI\\\\Codex|zh-cn-patched|WindowsApps\\\\OpenAI\\.Codex_|CodexHelper|codex-helper'",
  "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
].join("; ");

function listRunningCodexProcesses() {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", CODEX_PS_DETECT],
    { encoding: "utf8", timeout: 8000 }
  );
  const raw = result.stdout?.trim();
  if (!raw) return [];
  return raw.split(",").filter(Boolean);
}

function stopCodex({ includePathScan = true } = {}) {
  logInfo("正在结束 Codex / codex / codex-helper 进程…");
  spawnSync(
    "powershell",
    ["-NoProfile", "-Command", CODEX_PS_STOP_FAST],
    { encoding: "utf8", timeout: 20000 }
  );
  if (includePathScan) {
    logInfo("正在扫描并结束其他路径下的 Codex 相关进程（约 5–15 秒）…");
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command", CODEX_PS_STOP_PATH],
      { encoding: "utf8", timeout: 60000 }
    );
  }
}

function ensureCodexStopped(step = 1, total = INSTALL_STEP_TOTAL) {
  const running = listRunningCodexProcesses();
  if (running.length === 0) {
    logInfo("Codex 当前未运行。");
    return;
  }

  progressLog(
    step,
    total,
    `检测到 Codex 正在运行（${running.join(", ")}），正在关闭…`
  );
  stopCodex();

  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const still = listRunningCodexProcesses();
    if (still.length === 0) {
      logOk("Codex 已完全退出。");
      return;
    }
    if (attempt === 4) {
      logInfo("仍有进程未退出，再次尝试强制结束…");
      stopCodex({ includePathScan: false });
    }
    logInfo(`等待进程退出… (${attempt}/${maxAttempts}，仍在运行: ${still.join(", ")})`);
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "Start-Sleep -Seconds 1"],
      { encoding: "utf8", timeout: 5000 }
    );
  }

  const remaining = listRunningCodexProcesses();
  if (remaining.length > 0) {
    throw new Error(
      `无法关闭 Codex（仍在运行: ${remaining.join(", ")}）。请退出 Codex、在托盘右键退出 codex-helper（CodexHelper），或在任务管理器中结束相关进程后重试。`
    );
  }
}

function findPatchedCodexExe(appDir) {
  for (const exeName of ["Codex.exe", "codex.exe"]) {
    const exePath = path.join(appDir, exeName);
    if (fs.existsSync(exePath)) return exePath;
  }
  return null;
}

function launchCodexExecutable(exePath) {
  const workDir = path.dirname(exePath);
  const escapedExe = exePath.replace(/'/g, "''");
  const escapedDir = workDir.replace(/'/g, "''");
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Start-Process -FilePath '${escapedExe}' -WorkingDirectory '${escapedDir}'`,
    ],
    { windowsHide: true, stdio: "ignore", timeout: 15000 }
  );
}

function launchCodexViaScript(scriptPath) {
  if (scriptPath.toLowerCase().endsWith(".vbs")) {
    spawnSync("wscript.exe", ["//B", scriptPath], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 15000,
    });
    return;
  }
  spawnSync("cmd.exe", ["/c", scriptPath], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 15000,
  });
}

function getInstallLauncherPaths() {
  return {
    vbs: path.join(projectRoot, "Codex 汉化版.vbs"),
    bat: path.join(projectRoot, "Codex 汉化版.bat"),
  };
}

function removeStaleDesktopLaunchers() {
  const desktopDir = path.join(os.homedir(), "Desktop");
  for (const name of ["Codex 汉化版.vbs", "Codex 汉化版.bat"]) {
    const target = path.join(desktopDir, name);
    if (!fs.existsSync(target)) continue;
    try {
      fs.unlinkSync(target);
      logInfo(`已移除桌面旧启动脚本: ${target}`);
    } catch {
      logInfo(`请手动删除桌面上的: ${name}`);
    }
  }
}

function startCodex(app, patchedRoot, mode) {
  const { vbs: installVbs, bat: installBat } = getInstallLauncherPaths();

  if (mode === "store-copy") {
    const exePath = findPatchedCodexExe(app);
    if (exePath) {
      launchCodexExecutable(exePath);
      console.log(`[ok] 汉化完成，已重新启动 Codex: ${exePath}`);
      console.log(`[codex-launch] ${exePath}`);
      return;
    }
    const scriptLauncher = [installVbs, installBat].find(
      (candidate) => candidate && fs.existsSync(candidate)
    );
    if (scriptLauncher) {
      launchCodexViaScript(scriptLauncher);
      console.log(`[ok] 汉化完成，已重新启动 Codex: ${scriptLauncher}`);
      console.log(`[codex-launch] ${scriptLauncher}`);
      return;
    }
  }

  const exePath = findPatchedCodexExe(app);
  if (exePath) {
    launchCodexExecutable(exePath);
    console.log(`[ok] 汉化完成，已重新启动 Codex: ${exePath}`);
    console.log(`[codex-launch] ${exePath}`);
    return;
  }

  const scriptLauncher = [installVbs, installBat].find(
    (candidate) => candidate && fs.existsSync(candidate)
  );
  if (scriptLauncher) {
    launchCodexViaScript(scriptLauncher);
    console.log(`[ok] 汉化完成，已重新启动 Codex: ${scriptLauncher}`);
    console.log(`[codex-launch] ${scriptLauncher}`);
    return;
  }

  console.log("[warn] 未找到 Codex 启动方式，请手动打开 Codex。");
}

function removeDirectoryRobust(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;

  try {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 400,
    });
    if (!fs.existsSync(targetPath)) return;
  } catch {
    // fall through to PowerShell cleanup
  }

  stopCodex({ includePathScan: false });

  logInfo(`正在清理旧汉化副本: ${targetPath}`);
  logInfo("若目录较大或曾被占用，取得权限可能需要 1–3 分钟…");
  const escaped = targetPath.replace(/'/g, "''");
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      [
        `if (Test-Path -LiteralPath '${escaped}') {`,
        `  takeown /f '${escaped}' /r /d y 2>$null | Out-Null`,
        `  icacls '${escaped}' /grant "$env:USERNAME:(F)" /t /c 2>$null | Out-Null`,
        `  Remove-Item -LiteralPath '${escaped}' -Force -Recurse -ErrorAction SilentlyContinue`,
        `}`,
      ].join(" "),
    ],
    { encoding: "utf8", timeout: 180000 }
  );

  if (!fs.existsSync(targetPath)) return;

  const trashPath = `${targetPath}.pending-delete-${Date.now()}`;
  try {
    fs.renameSync(targetPath, trashPath);
    console.log(`[warn] 目录被占用，已重命名为: ${trashPath}`);
    console.log("[warn] 可在重启电脑后手动删除；安装将继续使用新目录。");
  } catch (error) {
    console.warn(
      `[warn] 无法移除旧副本目录（${error.message}），将自动改用新的汉化目录继续安装。`
    );
  }
}

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(resourcesDir, name), "utf8"));
}

/** 旧版错误补丁：有 submenu 但缺少 id，会导致编辑/窗口菜单无法点击 */
const BROKEN_EDIT_MENU_RE =
  /\{label:`编辑`,submenu:\[[\s\S]*?\{role:`selectAll`,label:`全选`\}\]\}/g;
const BROKEN_WINDOW_MENU_RE =
  /\{label:`窗口`,submenu:\[[\s\S]*?\{role:`close`,label:`关闭`\}\]\}/g;
const ROLE_EDIT_MENU_RE =
  /\{role:`editMenu`,id:([a-zA-Z0-9_.$]+)(?:,label:`编辑`)?\}/g;
const ROLE_WINDOW_MENU_RE =
  /\{role:`windowMenu`,id:([a-zA-Z0-9_.$]+)(?:,label:`窗口`)?\}/g;

function buildLocalizedEditMenu(id) {
  return `{label:\`编辑\`,id:${id},submenu:[{role:\`undo\`,label:\`撤销\`},{role:\`redo\`,label:\`重做\`},{type:\`separator\`},{role:\`cut\`,label:\`剪切\`},{role:\`copy\`,label:\`复制\`},{role:\`paste\`,label:\`粘贴\`},{role:\`delete\`,label:\`删除\`},{type:\`separator\`},{role:\`selectAll\`,label:\`全选\`}]}`;
}

function buildLocalizedWindowMenu(id) {
  return `{label:\`窗口\`,id:${id},submenu:[{role:\`minimize\`,label:\`最小化\`},{role:\`zoom\`,label:\`缩放\`},{type:\`separator\`},{role:\`close\`,label:\`关闭\`}]}`;
}

function getRoleMenuIdPrefix(mainBundleText) {
  const match = mainBundleText.match(/\{role:`help`,id:([a-zA-Z0-9_.$]+)\}/);
  if (!match) return "t.Dn";
  return match[1].replace(/\.help$/, "");
}

function repairBrokenRoleMenus(text) {
  const prefix = getRoleMenuIdPrefix(text);
  let count = 0;
  const editFix = buildLocalizedEditMenu(`${prefix}.edit`);
  const windowFix = buildLocalizedWindowMenu(`${prefix}.window`);
  const next = text
    .replace(BROKEN_EDIT_MENU_RE, () => {
      count += 1;
      return editFix;
    })
    .replace(BROKEN_WINDOW_MENU_RE, () => {
      count += 1;
      return windowFix;
    });
  return { text: next, count };
}

function localizeRoleMenus(text) {
  let count = 0;
  const next = text
    .replace(ROLE_EDIT_MENU_RE, (_match, id) => {
      count += 1;
      return buildLocalizedEditMenu(id);
    })
    .replace(ROLE_WINDOW_MENU_RE, (_match, id) => {
      count += 1;
      return buildLocalizedWindowMenu(id);
    });
  return { text: next, count };
}

const ROLE_MENU_PATCHES = [
  [
    "About ${n.app.getName()}",
    "关于 ${n.app.getName()}",
  ],
  [
    "title:`About ${e}`",
    "title:`关于 ${e}`",
  ],
  [
    "KX=`About {appName}`",
    "KX=`关于 {appName}`",
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

const WEBVIEW_TEXT_PATCHES = [["title:`Featured`", "title:`精选`"]];

function patchRoleMenus(content) {
  let text = content.toString("utf8");
  let count = 0;
  const repaired = repairBrokenRoleMenus(text);
  text = repaired.text;
  count += repaired.count;
  if (repaired.count > 0) {
    logInfo(`已修复 ${repaired.count} 处旧版编辑/窗口菜单补丁。`);
  }
  const localized = localizeRoleMenus(text);
  text = localized.text;
  count += localized.count;
  if (localized.count > 0) {
    logInfo("已为编辑/窗口菜单写入中文子项（保留菜单 id）。");
  }
  for (const [source, target] of ROLE_MENU_PATCHES) {
    if (!text.includes(source)) continue;
    const matches = text.split(source).length - 1;
    text = text.replaceAll(source, target);
    count += matches;
  }
  return { buffer: Buffer.from(text, "utf8"), count };
}

function patchWebviewBundles(asarPath, replacements = WEBVIEW_TEXT_PATCHES) {
  logInfo("正在读取 app.asar（仅一次）…");
  const data = Buffer.from(fs.readFileSync(asarPath));
  const parsed = readAsarHeader(data, asarPath);
  const candidates = [];
  for (const [filePath] of walkAsarFiles(parsed.header)) {
    if (filePath.includes("webview/assets/") && filePath.endsWith(".js")) {
      candidates.push(filePath);
    }
  }

  const total = candidates.length;
  logInfo(`共 ${total} 个 webview 脚本，开始扫描并打补丁…`);

  const state = { data, parsed, label: asarPath };
  let count = 0;
  let lastPct = -1;

  for (let index = 0; index < candidates.length; index += 1) {
    const filePath = candidates[index];
    const current = index + 1;
    const pct = total > 0 ? Math.floor((current / total) * 100) : 100;
    if (pct !== lastPct || current === 1 || current === total) {
      logProgressBar(current, total, path.basename(filePath));
      lastPct = pct;
    }

    const entry = getAsarFileEntry(state.parsed.header, filePath);
    const offset = 8 + state.parsed.headerSize + Number(entry.offset);
    const text = state.data
      .subarray(offset, offset + Number(entry.size))
      .toString("utf8");
    let next = text;
    for (const [source, target] of replacements) {
      if (next.includes(source)) next = next.replaceAll(source, target);
    }
    if (next === text) continue;
    applyAsarBufferPatch(state, filePath, Buffer.from(next, "utf8"));
    count += 1;
    logOk(`webview 补丁: ${path.basename(filePath)}`);
  }

  logProgressBar(total, total, "扫描完成");
  if (count > 0) {
    logInfo(`正在写回 app.asar（已修改 ${count} 个文件）…`);
    writeInstallFile(asarPath, state.data);
  } else {
    logInfo("webview 文案无需修改，跳过写回。");
  }
  return count;
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
  ensureInstallWritable(target);
  writeInstallFile(target, fs.readFileSync(source));
  console.log(`[restore] ${fileName}`);
  return true;
}

function getCodexHome() {
  return path.join(os.homedir(), ".codex");
}

function isWindowsAppsInstall(targetPath) {
  const normalized = path.normalize(targetPath).toLowerCase();
  return normalized.includes(`${path.sep}windowsapps${path.sep}`);
}

function getInstallBackupRoot(app) {
  const key = crypto
    .createHash("sha256")
    .update(path.normalize(app).toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return path.join(getCodexHome(), "zh-cn-install-backups", key, "latest");
}

function resolveBackupRoot(app, resources) {
  const userRoot = getInstallBackupRoot(app);
  if (fs.existsSync(path.join(userRoot, "app.asar"))) return userRoot;
  const legacyRoot = path.join(resources, ".zh-cn-backups", "latest");
  if (fs.existsSync(path.join(legacyRoot, "app.asar"))) return legacyRoot;
  return userRoot;
}

function ensureInstallWritable(...targets) {
  const paths = [
    ...new Set(
      targets
        .filter(Boolean)
        .map((p) => path.normalize(p))
        .filter((p) => isWindowsAppsInstall(p))
    ),
  ];
  if (paths.length === 0) return;

  console.log("[info] 正在调整 WindowsApps 目录权限（Microsoft Store 安装）…");
  const lines = [];
  for (const target of paths) {
    const escaped = target.replace(/'/g, "''");
    lines.push(
      `$t = '${escaped}'`,
      "if (Test-Path -LiteralPath $t) {",
      "  & takeown.exe /f $t /a 2>$null | Out-Null",
      "  & icacls.exe $t /grant 'Administrators:(F)' /C 2>$null | Out-Null",
      "  & icacls.exe $t /grant \"$env:USERNAME:(F)\" /C 2>$null | Out-Null",
      "}",
      "$parent = Split-Path -LiteralPath $t -Parent",
      "if ($parent -and (Test-Path -LiteralPath $parent)) {",
      "  & takeown.exe /f $parent /a 2>$null | Out-Null",
      "  & icacls.exe $parent /grant 'Administrators:(F)' /C 2>$null | Out-Null",
      "  & icacls.exe $parent /grant \"$env:USERNAME:(F)\" /C 2>$null | Out-Null",
      "}"
    );
  }
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", lines.join("\n")],
    { encoding: "utf8", timeout: 120000 }
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    console.warn(
      `[warn] 权限调整可能不完整${detail ? `：${detail}` : ""}，将继续尝试写入…`
    );
  }
}

function prepareInstallWriteAccess(app, resources, asarPath) {
  const exeCandidates = ["Codex.exe", "codex.exe"].map((name) =>
    path.join(app, name)
  );
  ensureInstallWritable(
    resources,
    asarPath,
    app,
    ...exeCandidates.filter((p) => fs.existsSync(p))
  );
}

function writeInstallFile(filePath, data) {
  fs.writeFileSync(filePath, data);
}

function getPatchedAppKey(sourceApp) {
  return crypto
    .createHash("sha256")
    .update(path.normalize(sourceApp).toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

function getActivePatchedRootFile() {
  return path.join(getCodexHome(), "zh-cn-patched-active.txt");
}

function readActivePatchedRootRecord() {
  try {
    const lines = fs
      .readFileSync(getActivePatchedRootFile(), "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    if (lines.length === 0) return null;
    return { root: lines[0], sourceApp: lines[1] || "" };
  } catch {
    return null;
  }
}

function writeActivePatchedRootRecord(patchedRoot, sourceApp) {
  fs.mkdirSync(getCodexHome(), { recursive: true });
  fs.writeFileSync(
    getActivePatchedRootFile(),
    `${patchedRoot}\n${sourceApp}\n`,
    "utf8"
  );
}

function getPatchedAppRoot(sourceApp) {
  const active = readActivePatchedRootRecord();
  if (
    active?.root &&
    fs.existsSync(active.root) &&
    (!sourceApp || active.sourceApp === sourceApp)
  ) {
    return active.root;
  }
  const key = getPatchedAppKey(sourceApp);
  return path.join(getCodexHome(), "zh-cn-patched", key);
}

function readPatchedAppMarker(patchedRoot) {
  const marker = path.join(patchedRoot, ".zh-cn-source.txt");
  try {
    return fs.readFileSync(marker, "utf8").trim();
  } catch {
    return "";
  }
}

function ensurePatchedAppCopy(sourceApp, { skipStop = false } = {}) {
  let patchedRoot = getPatchedAppRoot(sourceApp);
  let patchedApp = path.join(patchedRoot, "app");
  let patchedAsar = path.join(patchedApp, "resources", "app.asar");

  if (
    readPatchedAppMarker(patchedRoot) === sourceApp &&
    fs.existsSync(patchedAsar)
  ) {
    logInfo("已存在可写副本，跳过复制。");
    writeActivePatchedRootRecord(patchedRoot, sourceApp);
    return {
      app: patchedApp,
      resources: path.join(patchedApp, "resources"),
      patchedRoot,
    };
  }

  progressLog(3, INSTALL_STEP_TOTAL, "准备 Store 版可写副本…");
  logInfo(`源目录: ${sourceApp}`);
  logInfo(`目标目录: ${patchedRoot}`);
  if (!skipStop) {
    ensureCodexStopped(3, INSTALL_STEP_TOTAL);
  }
  removeDirectoryRobust(patchedRoot);
  if (fs.existsSync(patchedRoot)) {
    const key = getPatchedAppKey(sourceApp);
    patchedRoot = path.join(
      getCodexHome(),
      "zh-cn-patched",
      `${key}-${Date.now()}`
    );
    patchedApp = path.join(patchedRoot, "app");
    patchedAsar = path.join(patchedApp, "resources", "app.asar");
    console.log(
      `[warn] 旧副本目录被占用，已改用新目录: ${patchedRoot}`
    );
  }

  fs.mkdirSync(patchedRoot, { recursive: true });
  progressLog(
    3,
    INSTALL_STEP_TOTAL,
    "正在复制 Codex 文件到用户目录（首次约 2–5 分钟，请勿关闭窗口）…"
  );
  const copyStarted = Date.now();
  runWithProgressHeartbeat("正在复制 Codex 文件", () => {
    fs.cpSync(sourceApp, patchedApp, { recursive: true });
  });
  const copySeconds = Math.round((Date.now() - copyStarted) / 1000);
  fs.writeFileSync(path.join(patchedRoot, ".zh-cn-source.txt"), sourceApp, "utf8");
  writeActivePatchedRootRecord(patchedRoot, sourceApp);
  logOk(`副本复制完成（耗时 ${copySeconds} 秒）: ${patchedApp}`);
  return {
    app: patchedApp,
    resources: path.join(patchedApp, "resources"),
    patchedRoot,
  };
}

function resolvePatchTarget(installInfo, options = {}) {
  const { app, resources } = installInfo;
  if (!isWindowsAppsInstall(app)) {
    return {
      app,
      resources,
      mode: "in-place",
      sourceApp: app,
      patchedRoot: null,
    };
  }

  const patchedRoot = getPatchedAppRoot(app);
  const patchedApp = path.join(patchedRoot, "app");
  const patchedAsar = path.join(patchedApp, "resources", "app.asar");
  const hasPatchedCopy =
    readPatchedAppMarker(patchedRoot) === app && fs.existsSync(patchedAsar);

  if (!fs.existsSync(path.join(resources, "app.asar"))) {
    if (options.preferExistingCopy && hasPatchedCopy) {
      return {
        app: patchedApp,
        resources: path.join(patchedApp, "resources"),
        mode: "store-copy",
        sourceApp: app,
        patchedRoot,
      };
    }
    throw new Error(
      "Store 版 app.asar 缺失或已损坏。请打开 Microsoft Store → Codex →「修复」或「重置」，完成后再运行汉化。"
    );
  }

  const patched = hasPatchedCopy
    ? {
        app: patchedApp,
        resources: path.join(patchedApp, "resources"),
        patchedRoot,
      }
    : ensurePatchedAppCopy(app, { skipStop: options.skipStop });
  return {
    app: patched.app,
    resources: patched.resources,
    mode: "store-copy",
    sourceApp: app,
    patchedRoot: patched.patchedRoot,
  };
}

function writePatchedLauncher(patchedApp) {
  if (!findPatchedCodexExe(patchedApp)) {
    throw new Error("副本中未找到 Codex.exe / codex.exe，无法创建启动脚本。");
  }

  const launchersDir = path.join(projectRoot, "launchers");
  const templateVbs = path.join(launchersDir, "Codex 汉化版.vbs");
  const templateBat = path.join(launchersDir, "Codex 汉化版.bat");
  if (!fs.existsSync(templateVbs) || !fs.existsSync(templateBat)) {
    throw new Error("缺少 launchers/Codex 汉化版.vbs 或 .bat 模板文件。");
  }

  const { vbs: installVbs, bat: installBat } = getInstallLauncherPaths();
  fs.copyFileSync(templateVbs, installVbs);
  fs.copyFileSync(templateBat, installBat);
  removeStaleDesktopLaunchers();

  logOk(`汉化版启动脚本已写入安装目录: ${installVbs}`);
  logOk(`备用启动脚本: ${installBat}`);
  console.log(
    `[info] 请在本目录双击「Codex 汉化版.vbs」启动（与 install-windows.bat 同目录）；勿用 Store 原版快捷方式。`
  );
}

function getPluginBackupRoot(codexHome) {
  return path.join(codexHome, ".zh-cn-backups", "latest");
}

function findBundledPluginJsonFiles(codexHome, extraRoots = []) {
  const results = new Set();
  const roots = [
    path.join(codexHome, "plugins", "cache", "openai-bundled"),
    path.join(codexHome, "plugins", "cache", "openai-primary-runtime"),
    path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins"),
    ...extraRoots,
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

function patchMarketplaceJson(marketplaceJsonPath, translations) {
  const marketplace = JSON.parse(fs.readFileSync(marketplaceJsonPath, "utf8"));
  const patch = translations["__marketplace__openai-bundled"];
  if (!patch?.displayName || !marketplace.interface) return false;
  if (marketplace.interface.displayName === patch.displayName) return false;
  marketplace.interface.displayName = patch.displayName;
  fs.writeFileSync(
    marketplaceJsonPath,
    `${JSON.stringify(marketplace, null, 2)}\n`,
    "utf8"
  );
  return true;
}

function findAppResourcePluginFiles(appDir) {
  const pluginsRoot = path.join(appDir, "resources", "plugins");
  const results = {
    pluginJson: [],
    marketplaceJson: [],
  };
  if (!fs.existsSync(pluginsRoot)) return results;

  const marketplaceJson = path.join(
    pluginsRoot,
    "openai-bundled",
    ".agents",
    "plugins",
    "marketplace.json"
  );
  if (fs.existsSync(marketplaceJson)) {
    results.marketplaceJson.push(marketplaceJson);
  }

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".codex-plugin") {
          const pluginJson = path.join(next, "plugin.json");
          if (fs.existsSync(pluginJson)) results.pluginJson.push(pluginJson);
          continue;
        }
        walk(next);
      }
    }
  }
  walk(pluginsRoot);
  return results;
}

function patchAppResourcePlugins(appDir, translations) {
  const { pluginJson, marketplaceJson } = findAppResourcePluginFiles(appDir);
  let count = 0;
  for (const filePath of marketplaceJson) {
    if (patchMarketplaceJson(filePath, translations)) {
      count += 1;
      console.log(`[ok] 已汉化市场 ${path.relative(appDir, filePath)}`);
    }
  }
  for (const filePath of pluginJson) {
    if (patchPluginInterface(filePath, translations)) {
      count += 1;
      console.log(`[ok] 已汉化应用内插件 ${path.relative(appDir, filePath)}`);
    }
  }
  return count;
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

function patchBundledPlugins(translations, options = {}) {
  const codexHome = getCodexHome();
  const backupRoot = getPluginBackupRoot(codexHome);
  const pluginJsonPaths = findBundledPluginJsonFiles(
    codexHome,
    options.extraPluginRoots || []
  );

  let count = 0;
  if (options.appDir) {
    count += patchAppResourcePlugins(options.appDir, translations);
  }

  if (pluginJsonPaths.length === 0 && count === 0) {
    console.log("[warn] 未找到内置插件 plugin.json，请先启动一次 Codex 后再安装。");
    return count;
  }

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
  console.log("[progress] ========== 开始安装 Codex 简体中文汉化 ==========");
  progressLog(1, INSTALL_STEP_TOTAL, "关闭 Codex 及相关进程…");
  ensureCodexStopped(1, INSTALL_STEP_TOTAL);

  progressLog(2, INSTALL_STEP_TOTAL, "查找 Codex 安装目录…");
  const installInfo = findCodexInstall(options.codexPath);
  logOk(`已找到 Codex: ${installInfo.app}`);

  const target = resolvePatchTarget(installInfo, { skipStop: true });
  const { app, resources, mode, sourceApp, patchedRoot } = target;
  const asarPath = path.join(resources, "app.asar");
  const backupRoot = getInstallBackupRoot(app);

  if (mode === "store-copy") {
    logInfo(`Store 源目录: ${sourceApp}`);
  }
  progressLog(4, INSTALL_STEP_TOTAL, "备份原始文件…");
  logInfo(`补丁目录: ${app}`);
  logInfo(`备份目录: ${backupRoot}`);

  if (mode === "in-place") {
    prepareInstallWriteAccess(app, resources, asarPath);
  }

  backupFile(asarPath, backupRoot);
  backupFile(path.join(app, "Codex.exe"), backupRoot);
  backupFile(path.join(app, "codex.exe"), backupRoot);
  logOk("备份完成。");

  progressLog(5, INSTALL_STEP_TOTAL, "写入 app.asar 汉化补丁…");
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

  progressLog(6, INSTALL_STEP_TOTAL, "汉化 webview 与界面文案…");
  const webviewPatchCount = patchWebviewBundles(asarPath);
  if (webviewPatchCount > 0) {
    logOk(`已补丁 webview 文案 ${webviewPatchCount} 个文件`);
  }

  progressLog(7, INSTALL_STEP_TOTAL, "设置语言并汉化内置插件…");
  setCodexLocale();

  const bundledPlugins = loadJson("bundled-plugins-zh-CN.json");
  const pluginCount = patchBundledPlugins(bundledPlugins, { appDir: app });
  if (pluginCount > 0) {
    logOk(`已汉化内置插件 metadata ${pluginCount} 处`);
  }

  if (mode === "store-copy") {
    writePatchedLauncher(app);
    console.log(`[codex-app] ${app}`);
    logOk("汉化补丁已写入副本。");
  } else {
    console.log(`[codex-app] ${app}`);
    logOk("汉化补丁已写入。");
  }

  if (options.relaunch !== false) {
    progressLog(8, INSTALL_STEP_TOTAL, "重新启动 Codex…");
    startCodex(app, patchedRoot, mode);
  } else {
    logInfo("已跳过自动启动（使用了 --no-relaunch）。");
  }
  console.log("[progress] ========== 汉化安装完成 ==========");
}

function uninstall(options) {
  ensureCodexStopped();
  const installInfo = findCodexInstall(options.codexPath);
  const target = resolvePatchTarget(installInfo, { preferExistingCopy: true });
  const { app, resources, mode } = target;
  const asarPath = path.join(resources, "app.asar");
  const backupRoot = resolveBackupRoot(app, resources);
  if (mode === "in-place") {
    prepareInstallWriteAccess(app, resources, asarPath);
  }

  if (restoreBackup(backupRoot, resources, "app.asar")) {
    syncExeAsarIntegrity(app, asarPath);
  }
  for (const exeName of ["Codex.exe", "codex.exe"]) {
    restoreBackup(backupRoot, app, exeName);
  }
  restoreCodexLocale();
  const restoredPlugins = restoreBundledPlugins();
  if (restoredPlugins > 0) {
    console.log(`[ok] 已恢复 ${restoredPlugins} 个插件 metadata 文件`);
  }
  console.log("[ok] 已恢复原样。");
}

function isCodexRunning() {
  return listRunningCodexProcesses().length > 0;
}

function isAsarLocalized(asarPath) {
  try {
    const content = fs.readFileSync(asarPath).toString("utf8");
    return (
      content.includes("label:`文件`") &&
      content.includes("关于 ${n.app.getName()}") &&
      content.includes("{label:`编辑`,id:") &&
      content.includes("label:`撤销`") &&
      content.includes("label:`最小化`") &&
      !BROKEN_EDIT_MENU_RE.test(content)
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
    const patchTarget = isWindowsAppsInstall(installInfo.app)
      ? (() => {
          const patchedRoot = getPatchedAppRoot(installInfo.app);
          const patchedApp = path.join(patchedRoot, "app");
          const patchedAsar = path.join(patchedApp, "resources", "app.asar");
          if (
            readPatchedAppMarker(patchedRoot) === installInfo.app &&
            fs.existsSync(patchedAsar)
          ) {
            return {
              app: patchedApp,
              resources: path.join(patchedApp, "resources"),
            };
          }
          return installInfo;
        })()
      : installInfo;
    const checkApp = patchTarget.app || installInfo.app;
    const checkResources = patchTarget.resources || installInfo.resources;
    const backupRoot = resolveBackupRoot(checkApp, checkResources);
    report.asarBackup = fs.existsSync(path.join(backupRoot, "app.asar"));
    report.exeBackup =
      fs.existsSync(path.join(backupRoot, "Codex.exe")) ||
      fs.existsSync(path.join(backupRoot, "codex.exe"));
    report.asarLocalized = isAsarLocalized(
      path.join(checkResources, "app.asar")
    );
    if (isWindowsAppsInstall(installInfo.app)) {
      report.messages.push(
        "检测到 Microsoft Store 安装：将在 %USERPROFILE%\\.codex\\zh-cn-patched\\ 维护可写副本；请用安装目录下的「Codex 汉化版.vbs」启动。"
      );
      const { vbs: launcher } = getInstallLauncherPaths();
      if (fs.existsSync(launcher)) {
        report.messages.push(`汉化启动脚本: ${launcher}`);
      }
    }
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
    report.messages.push(
      "检测到 Codex 正在运行：安装汉化时会先自动关闭，完成后自动重启。"
    );
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
  let relaunch = true;
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--codex-path" && argv[i + 1]) {
      codexPath = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--json") {
      json = true;
    } else if (argv[i] === "--no-relaunch") {
      relaunch = false;
    }
  }
  return { action, codexPath, json, relaunch };
}

const options = parseArgs(process.argv);
try {
  if (options.action === "status") status(options);
  else if (options.action === "uninstall") uninstall(options);
  else if (options.action === "install") install(options);
  else if (options.action === "save-path") {
    if (!options.codexPath) throw new Error("save-path 需要 --codex-path");
    writeSavedCodexPath(options.codexPath);
    const resolved = resolveCodexInstallDir(options.codexPath);
    console.log(`[ok] 已保存 Codex 路径: ${resolved.app}`);
  } else if (options.action === "clear-path") {
    clearSavedCodexPath();
    console.log("[ok] 已清除保存的 Codex 路径");
  } else throw new Error(`未知操作: ${options.action}`);
} catch (error) {
  console.error(`[error] ${error.message}`);
  process.exit(1);
}
