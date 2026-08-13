' ==========================================================
'  TrackRakho Tally connector - invisible runner
'
'  No arguments   : start the connector with NO window, writing everything
'                   to connector.log next to this file.
'  /install       : also make Windows start it automatically at every logon
'                   (a shortcut in the user's Startup folder), then start it.
'  /uninstall     : remove that Startup shortcut (does not stop a running one).
'
'  Every path used here is ABSOLUTE, so this works even when the folder sits
'  on a network share - cmd.exe and WScript cannot "cd" into a \\server\path.
' ==========================================================

Option Explicit

Dim sh, fso, here, scriptPath, logPath, mode, startupLnk
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here       = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = here & "\quotekaro-tally-connector.mjs"
logPath    = here & "\connector.log"
startupLnk = sh.SpecialFolders("Startup") & "\TrackRakho Connector.lnk"

mode = ""
If WScript.Arguments.Count > 0 Then mode = LCase(WScript.Arguments(0))

' ---------- /uninstall : just remove the autostart entry ----------
If mode = "/uninstall" Then
  If fso.FileExists(startupLnk) Then fso.DeleteFile startupLnk
  WScript.Quit 0
End If

' ---------- /install : create the Startup shortcut ----------
If mode = "/install" Then
  Dim lnk
  Set lnk = sh.CreateShortcut(startupLnk)
  lnk.TargetPath   = "wscript.exe"
  lnk.Arguments    = """" & WScript.ScriptFullName & """"
  lnk.Description  = "TrackRakho - Tally connector (runs in the background)"
  lnk.WindowStyle  = 7                 ' minimised, though wscript shows nothing anyway
  lnk.Save
End If

' ---------- keep connector.log from growing forever ----------
If fso.FileExists(logPath) Then
  If fso.GetFile(logPath).Size > 2000000 Then
    If fso.FileExists(logPath & ".old") Then fso.DeleteFile logPath & ".old"
    fso.MoveFile logPath, logPath & ".old"
  End If
End If

' ---------- start the connector, hidden, output appended to the log ----------
' 0 = no window at all, False = do not wait for it to finish.
sh.Run "cmd /c node """ & scriptPath & """ >> """ & logPath & """ 2>&1", 0, False

WScript.Quit 0
