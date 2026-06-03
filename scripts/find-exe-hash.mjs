import fs from "node:fs";

const exePath = process.argv[2] || "D:/soft/Codex-win-x64-26.519.81530/Codex.exe";
const expectedHash = process.argv[3] || "6a80b29f6d44de61e54f24bfda46e256cb80a631f8605677b8cd97cb610612e";
const exe = fs.readFileSync(exePath);
const text = exe.toString("latin1");
const idx = text.indexOf(expectedHash);
console.log("hash index:", idx);
if (idx >= 0) {
  console.log("context:", JSON.stringify(text.substring(Math.max(0, idx - 80), idx + 80)));
}
for (const pat of ["app.asar", "SHA256", "integrity", "asar"]) {
  let i = 0,
    c = 0;
  while ((i = text.indexOf(pat, i + 1)) >= 0 && c < 5) {
    if (pat === "SHA256" || pat === "app.asar") {
      console.log(pat, i, JSON.stringify(text.substring(i, i + 120)));
    }
    c++;
  }
}
