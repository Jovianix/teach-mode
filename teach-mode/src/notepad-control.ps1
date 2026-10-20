$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try {
  Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
public static class TeachInput {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public uint size,flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public RECT caretRect; }
  static IntPtr expectedEditor;
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort key, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit,Size=40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT keyboard; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr editor);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  static INPUT Key(ushort key, bool up) { INPUT i=new INPUT(); i.type=1; i.keyboard.key=key; i.keyboard.flags=up?2u:0u; return i; }
  static IntPtr FocusedChild(IntPtr window) { uint pid; uint thread=GetWindowThreadProcessId(window,out pid); var info=new GUITHREADINFO(); info.size=(uint)Marshal.SizeOf(typeof(GUITHREADINFO)); return GetGUIThreadInfo(thread,ref info)?info.focus:IntPtr.Zero; }
  static void Check(IntPtr window) {
    if(GetForegroundWindow()!=window) throw new Exception("teach_notepad_focus_lost");
    if(expectedEditor!=IntPtr.Zero && FocusedChild(window)!=expectedEditor) throw new Exception("teach_notepad_editor_focus_changed");
  }
  public static void FocusEdit(IntPtr window, IntPtr editor) {
    if(GetForegroundWindow()!=window) throw new Exception("teach_notepad_focus_unavailable");
    uint pid; uint target=GetWindowThreadProcessId(window,out pid), current=GetCurrentThreadId();
    bool attached=current!=target && AttachThreadInput(current,target,true);
    try { SetFocus(editor); } finally { if(attached)AttachThreadInput(current,target,false); }
    expectedEditor=editor; Check(window);
  }
  static void Send(INPUT[] inputs, IntPtr window) { Check(window); if(SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)))!=inputs.Length) throw new Exception("teach_notepad_input_failed"); }
  public static void Activate(IntPtr window) {
    ShowWindow(window,9);
    if(GetForegroundWindow()==window) return;
    // The user explicitly started this foreground workflow. Like Memmy's
    // foreground input backend, an empty input claims the last-input source
    // without pressing a key or moving the pointer. Keep exact-window checks.
    if(SendInput(1,new[]{new INPUT()},Marshal.SizeOf(typeof(INPUT)))!=1 || !SetForegroundWindow(window)) throw new Exception("teach_notepad_focus_unavailable");
  }
  public static void Hotkey(IntPtr window, ushort key) { Send(new[]{Key(17,false),Key(key,false),Key(key,true),Key(17,true)},window); }
  public static void Type(IntPtr window, string text) {
    foreach(char c in text.Replace("\r\n","\n").Replace("\r","\n")) {
      if(c=='\n') { Send(new[]{Key(13,false),Key(13,true)},window); }
      else { INPUT down=new INPUT(); down.type=1; down.keyboard.scan=c; down.keyboard.flags=4; INPUT up=down; up.keyboard.flags=6; Send(new[]{down,up},window); }
      Thread.Sleep(2);
    }
  }
  public static string ClassName(IntPtr window) { var text=new StringBuilder(128); GetClassName(window,text,128); return text.ToString(); }
  public static string ReadEdit(IntPtr editor) {
    var text=new StringBuilder(20004); UIntPtr result;
    if(SendMessageTimeout(editor,13,new IntPtr(text.Capacity),text,2,2000,out result)==IntPtr.Zero) throw new Exception("teach_notepad_readback_timeout");
    return text.ToString();
  }
}
'@
  $request = [Console]::ReadLine() | ConvertFrom-Json
  if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'teach_interactive_desktop_required' }
  if ($request.op -eq 'open') {
    $file = [IO.Path]::GetFullPath([string]$request.file)
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'teach_note_file_missing' }
    $exe = Join-Path $env:SystemRoot 'System32\notepad.exe'
    # Saved notes can stay open after uninstall; their process must not hold the plugin directory.
    $started = Start-Process -FilePath $exe -ArgumentList ('"' + $file + '"') -WorkingDirectory ([IO.Path]::GetDirectoryName($file)) -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $process = $null
    do {
      $found = @(Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object {
        $_.SessionId -eq (Get-Process -Id $PID).SessionId -and $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle.Contains([IO.Path]::GetFileName($file))
      })
      if ($found.Count -eq 1) { $process = $found[0]; break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -eq $process) { throw 'teach_notepad_window_not_unique' }
    $target = @{ pid=$process.Id; hwnd=$process.MainWindowHandle.ToInt64().ToString(); processStart=$process.StartTime.ToFileTimeUtc().ToString(); executable=$process.Path; file=$file }
  } else {
    $target = $request.target
    $process = Get-Process -Id ([int]$target.pid)
    if ($process.ProcessName -ne 'notepad' -or $process.SessionId -ne (Get-Process -Id $PID).SessionId -or
      $process.StartTime.ToFileTimeUtc().ToString() -ne $target.processStart -or $process.Path -ne $target.executable) { throw 'teach_notepad_identity_changed' }
  }
  $window = [IntPtr][long]$target.hwnd
  [uint32]$owner = 0
  [void][TeachInput]::GetWindowThreadProcessId($window,[ref]$owner)
  if ($owner -ne $process.Id -or -not $process.MainWindowTitle.Contains([IO.Path]::GetFileName([string]$target.file))) { throw 'teach_notepad_window_changed' }
  $root = [Windows.Automation.AutomationElement]::FromHandle($window)
  $condition = New-Object Windows.Automation.OrCondition(
    (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Document)),
    (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)))
  $nodes = $root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
  $editors = @()
  foreach ($node in $nodes) {
    if (-not $node.Current.IsOffscreen -and -not $node.Current.IsPassword -and $node.Current.BoundingRectangle.Height -gt 80) { $editors += $node }
  }
  $classicEdit = [IntPtr]::Zero
  if ($editors.Count -eq 1) {
    $editor = $editors[0]
    $editorBackend = 'uia'
  } elseif ($editors.Count -eq 0 -and $process.Path -eq (Join-Path $env:SystemRoot 'System32\notepad.exe')) {
    # On some Windows installations classic Notepad exposes only a Pane through
    # UIA. Read its exact, documented Win32 Edit control; never infer saved text.
    $classicEdit = [TeachInput]::GetDlgItem($window,15)
    [uint32]$editOwner = 0
    [void][TeachInput]::GetWindowThreadProcessId($classicEdit,[ref]$editOwner)
    if ($classicEdit -eq [IntPtr]::Zero -or $editOwner -ne $process.Id -or [TeachInput]::ClassName($classicEdit) -ne 'Edit') { throw 'teach_notepad_editor_not_unique' }
    $editor = [Windows.Automation.AutomationElement]::FromHandle($classicEdit)
    $editorBackend = 'win32_edit'
  } else { throw 'teach_notepad_editor_not_unique' }
  if ($request.op -eq 'open') { $target.editorBackend = $editorBackend }
  elseif ($target.editorBackend -and $target.editorBackend -ne $editorBackend) { throw 'teach_notepad_editor_changed' }
  if ($request.op -eq 'focus' -or $request.op -eq 'write') {
    [TeachInput]::Activate($window)
    if ($editorBackend -eq 'win32_edit') { [TeachInput]::FocusEdit($window,$classicEdit) }
    else { $editor.SetFocus() }
    Start-Sleep -Milliseconds 250
    if ([TeachInput]::GetForegroundWindow() -ne $window) { throw 'teach_notepad_focus_unavailable' }
  }
  if ($request.op -eq 'write') {
    if ($request.text -isnot [string] -or $request.text.Length -gt 20000 -or $request.text.Length -lt 1) { throw 'teach_note_text_invalid' }
    [TeachInput]::Hotkey($window,65)
    [TeachInput]::Type($window,[string]$request.text)
    [TeachInput]::Hotkey($window,83)
    Start-Sleep -Milliseconds 350
  }
  $pattern = $null
  if ($editorBackend -eq 'win32_edit') {
    $text = [TeachInput]::ReadEdit($classicEdit)
  } elseif ($editor.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) {
    $text = ([Windows.Automation.TextPattern]$pattern).DocumentRange.GetText(20003)
  } elseif ($editor.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) {
    $text = ([Windows.Automation.ValuePattern]$pattern).Current.Value
  } else { throw 'teach_notepad_readback_unavailable' }
  @{ok=$true; target=$target; text=[string]$text; editor=@{automationId=$editor.Current.AutomationId; className=$editor.Current.ClassName}} | ConvertTo-Json -Depth 8 -Compress | Write-Output
} catch {
  @{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress | Write-Output
}
