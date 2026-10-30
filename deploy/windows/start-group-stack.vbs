Option Explicit

Dim files, shell, root, launcher, powershell, command, result
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count > 0 Then
    root = files.GetAbsolutePathName(WScript.Arguments(0))
Else
    root = files.GetAbsolutePathName(files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "..\.."))
End If
launcher = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "start-group-stack.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Chr(34) & powershell & Chr(34) & " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & launcher & Chr(34) & " -PlatformRoot " & Chr(34) & root & Chr(34)
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
    MsgBox "Synrex Group could not start: " & Err.Description, vbExclamation, "Synrex Group"
    WScript.Quit 1
End If
On Error GoTo 0
If result <> 0 Then MsgBox "Synrex Group startup failed (exit " & result & "). Check the Group logs.", vbExclamation, "Synrex Group"
WScript.Quit result
