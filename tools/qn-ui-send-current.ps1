param(
  [string]$Text = "codex-ui-send-$(Get-Date -Format 'HHmmss')",
  [ValidateSet('Enter', 'CtrlEnter')]
  [string]$SendChord = 'Enter',
  [int]$BeforePasteDelayMs = 700,
  [int]$AfterPasteDelayMs = 300,
  [switch]$NoSend
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

function Set-ClipboardTextSta([string]$Value) {
  $thread = [System.Threading.Thread] {
    param($TextToSet)
    [System.Windows.Forms.Clipboard]::SetText($TextToSet)
  }
  $thread.SetApartmentState([System.Threading.ApartmentState]::STA)
  $thread.Start($Value)
  $thread.Join()
}

Write-Host '请先把鼠标点到千牛当前会话的消息输入框。'
Write-Host "将发送文本: $Text"
Write-Host '3 秒后开始粘贴。按 Ctrl+C 可取消。'
Start-Sleep -Seconds 3

Set-ClipboardTextSta $Text
Start-Sleep -Milliseconds $BeforePasteDelayMs

[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds $AfterPasteDelayMs

if ($NoSend) {
  Write-Host '已粘贴，未发送。'
  exit 0
}

if ($SendChord -eq 'CtrlEnter') {
  [System.Windows.Forms.SendKeys]::SendWait('^{ENTER}')
} else {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}

Write-Host '已触发发送快捷键。请用 hook 日志或 app.log 确认 sendStatus/messageId。'
