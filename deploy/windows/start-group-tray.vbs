Option Explicit

Dim files, shell, root, launcher, powershell, command, result
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = files.GetAbsolutePathName(files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "..\.."))
launcher = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "start-synrex-console.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
shell.Environment("PROCESS")("SYNREX_CONSOLE_START_HIDDEN") = "1"
command = Chr(34) & powershell & Chr(34) & " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & launcher & Chr(34) & " -PlatformRoot " & Chr(34) & root & Chr(34)
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then WScript.Quit 1
On Error GoTo 0
WScript.Quit result
