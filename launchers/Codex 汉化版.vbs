' Codex Desktop 简体中文汉化版启动器（无 cmd 黑窗）
' 依赖：先运行 install-windows.bat 完成汉化

Option Explicit

Dim fso, shell, codexHome, activeFile, ts, patchedRoot, appDir, exePath

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
codexHome = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.codex"
activeFile = codexHome & "\zh-cn-patched-active.txt"

If Not fso.FileExists(activeFile) Then
  MsgBox "未找到汉化副本记录。" & vbCrLf & vbCrLf & "请先运行 install-windows.bat，选择 [1] 安装汉化。", vbCritical, "Codex 汉化版"
  WScript.Quit 1
End If

Set ts = fso.OpenTextFile(activeFile, 1)
patchedRoot = Trim(ts.ReadLine)
ts.Close

If patchedRoot = "" Or Not fso.FolderExists(patchedRoot) Then
  MsgBox "汉化副本目录无效或已删除，请重新安装汉化。", vbCritical, "Codex 汉化版"
  WScript.Quit 1
End If

appDir = patchedRoot & "\app"
exePath = appDir & "\Codex.exe"
If Not fso.FileExists(exePath) Then
  exePath = appDir & "\codex.exe"
End If

If Not fso.FileExists(exePath) Then
  MsgBox "在汉化副本中未找到 Codex.exe，请重新安装汉化。", vbCritical, "Codex 汉化版"
  WScript.Quit 1
End If

shell.CurrentDirectory = appDir
shell.Run Chr(34) & exePath & Chr(34), 1, False
