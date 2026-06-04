import fs from "node:fs";

const asarPath = process.argv[2] || "D:/soft/Codex-win-x64-26.519.81530/resources/app.asar";
const asar = fs.readFileSync(asarPath);
const hs = asar.readUInt32LE(4);
const hp = asar.subarray(8, 8 + hs);
const hss = hp.readInt32LE(4);
const header = JSON.parse(hp.subarray(8, 8 + hss).toString("utf8"));

function find(node, p = "") {
  if (node.files) {
    for (const [n, c] of Object.entries(node.files)) {
      find(c, p ? `${p}/${n}` : n);
    }
  } else if (
    node.offset !== undefined &&
    p === "native-menu-locales/zh-CN.json"
  ) {
    const off = 8 + hs + Number(node.offset);
    const json = JSON.parse(asar.subarray(off, off + node.size).toString("utf8"));
    console.log("native-menu keys:", Object.keys(json).length);
    console.log("toggleSidebar:", json["codex.commandMenuTitle.toggleSidebar"]);
    console.log("toggleTerminal:", json["codex.commandMenuTitle.toggleTerminal"]);
  }
}
find(header);

const s = asar.toString("utf8");
console.log("label File:", s.includes("label:`File`"));
console.log("label 文件:", s.includes("label:`文件`"));
console.log("label View:", s.includes("label:`View`"));
console.log("label 查看:", s.includes("label:`查看`"));
console.log("Zoom In:", s.includes("label:`Zoom In`"));
console.log("放大:", s.includes("label:`放大`"));
console.log("edit submenu zh:", /{label:`编辑`,id:[a-zA-Z0-9_.$]+,submenu:.*label:`撤销`/.test(s));
console.log("window submenu zh:", /{label:`窗口`,id:[a-zA-Z0-9_.$]+,submenu:.*label:`最小化`/.test(s));
console.log("broken edit (no id):", /\{label:`编辑`,submenu:/.test(s) && !/{label:`编辑`,id:/.test(s));
console.log("Start Performance Trace:", s.includes("`Start Performance Trace`"));
console.log("开始性能跟踪:", s.includes("`开始性能跟踪`"));
console.log("About Codex template:", s.includes("About ${n.app.getName()}"));
console.log("关于 Codex template:", s.includes("关于 ${n.app.getName()}"));
console.log("quit Exit role only:", s.includes("{role:`quit`}"));
console.log("quit 退出 label:", s.includes("{role:`quit`,label:`退出`}"));
