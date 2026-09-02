param(
  [ValidateSet('install', 'restore')]
  [string]$Mode = 'install',
  [string]$QnVersionDir = 'D:\qianniu\9.97.74N',
  [string]$BackupDir = '',
  [string]$Endpoint = 'http://127.0.0.1:18082/qn-bridge'
)

$ErrorActionPreference = 'Stop'

$webuiDir = Join-Path $QnVersionDir 'Resources\newWebui'
$zipPath = Join-Path $webuiDir 'webui.zip'
$signPath = Join-Path $webuiDir 'sign.json'
$entryName = 'web_chat-packer/recent.html'
$marker = 'codex-qn-bridge-hook-v3'

function New-BackupDir {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dir = "D:\packet-capture\qianniu-bridge-hook-backup-$stamp"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Copy-Backup([string]$dir) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item -LiteralPath $zipPath -Destination (Join-Path $dir 'webui.zip') -Force
  if (Test-Path -LiteralPath $signPath) {
    Copy-Item -LiteralPath $signPath -Destination (Join-Path $dir 'sign.json') -Force
  }
}

function Restore-Backup([string]$dir) {
  if (-not $dir) {
    $dir = Get-ChildItem -LiteralPath 'D:\packet-capture' -Directory -Filter 'qianniu-bridge-hook-backup-*' |
      Sort-Object Name -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $dir) { throw 'No qianniu bridge hook backup directory was found.' }

  $backupZip = Join-Path $dir 'webui.zip'
  $backupSign = Join-Path $dir 'sign.json'
  if (-not (Test-Path -LiteralPath $backupZip)) { throw "Backup webui.zip not found: $backupZip" }

  Copy-Item -LiteralPath $backupZip -Destination $zipPath -Force
  if (Test-Path -LiteralPath $backupSign) {
    Copy-Item -LiteralPath $backupSign -Destination $signPath -Force
  }
  Write-Host "RESTORED`t$dir"
}

function Get-HookScript([string]$endpoint) {
  $safeEndpoint = $endpoint.Replace('\', '\\').Replace("'", "\'")
  return @"
    <script>
      // $marker
      (function () {
        if (window.__codexQnBridgeHookV3) return;
        window.__codexQnBridgeHookV3 = {
          installedAt: Date.now(),
          sent: Object.create(null),
          callSeq: 0,
          installedPosted: false
        };
        var state = window.__codexQnBridgeHookV3;
        var endpoint = '$safeEndpoint';
        var imsdkAllow = /^(im\.(singlemsg|imbamsg|amptribemsg)\.(GetLocalHisMsg|GetLocalPageMsg|GetRemoteHisMsg|GetNewMsg)|im\.uiutil\.GetCurrentConversationID|im\.login\.GetCurrentLoginID)$/;
        var workbenchCmdAllow = /(Send|send|Msg|Message|message|Typing|typing|Convert|Quote|Chat|chat|Card|Url|MTop|Request|request)/;
        var workbenchNamespaceAllow = /(^|\.)((im|singlemsg|imbamsg|amptribemsg|tribemsg|bizutil|uiutil|login|httprequest|app))(\.|$)/;
        function parse(value) {
          if (typeof value !== 'string') return value;
          try { return JSON.parse(value); } catch (e) { return value; }
        }
        function shallow(value, depth, seen) {
          if (value == null) return value;
          if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) + '...[truncated]' : value;
          if (typeof value === 'number' || typeof value === 'boolean') return value;
          if (typeof value === 'function') return '[function]';
          if (typeof value !== 'object') return String(value);
          seen = seen || [];
          if (seen.indexOf(value) >= 0) return '[circular]';
          if (depth <= 0) return Array.isArray(value) ? '[array]' : '[object]';
          seen.push(value);
          if (Array.isArray(value)) {
            var arr = [];
            for (var i = 0; i < value.length && i < 20; i += 1) arr.push(shallow(value[i], depth - 1, seen));
            if (value.length > 20) arr.push('...[+' + (value.length - 20) + ']');
            seen.pop();
            return arr;
          }
          var out = {};
          var keys = Object.keys(value);
          for (var j = 0; j < keys.length && j < 40; j += 1) out[keys[j]] = shallow(value[keys[j]], depth - 1, seen);
          if (keys.length > 40) out.__truncatedKeys = keys.length - 40;
          seen.pop();
          return out;
        }
        function currentState() {
          var vs = window._vs || {};
          return {
            href: location.href,
            chatType: vs.chatType || '',
            conversationID: shallow(vs.conversationID || {}, 2),
            loginID: shallow(vs.loginID || {}, 2)
          };
        }
        function cidCode(value) {
          if (!value) return '';
          if (typeof value === 'string') return value;
          return value.ccode || value.code || '';
        }
        function idObj(value) {
          return value && typeof value === 'object' ? value : {};
        }
        function textFrom(originalData) {
          if (!originalData || typeof originalData !== 'object') return '';
          if (typeof originalData.text === 'string') return originalData.text;
          var views = Array.isArray(originalData.jsview) ? originalData.jsview : [];
          for (var i = 0; i < views.length; i += 1) {
            var value = views[i] && views[i].value;
            if (value && typeof value.text === 'string') return value.text;
          }
          return '';
        }
        function currentLoginId(msg) {
          var login = idObj(msg.loginid);
          return login.targetId || (window._vs && window._vs.loginID && window._vs.loginID.targetId) || '';
        }
        function normalizeMessage(msg, paramCid) {
          if (!msg || typeof msg !== 'object') return null;
          var from = idObj(msg.fromid || msg.fromId);
          var to = idObj(msg.toid || msg.toId);
          var mcode = idObj(msg.mcode);
          var loginId = currentLoginId(msg);
          var direction = '';
          if (loginId && from.targetId === loginId) direction = 'outgoing';
          else if (loginId && to.targetId === loginId) direction = 'incoming';
          var row = {
            cid: cidCode(msg.cid) || paramCid || '',
            direction: direction,
            fromNick: from.nick || '',
            fromId: from.targetId || '',
            toNick: to.nick || '',
            toId: to.targetId || '',
            clientId: mcode.clientId || msg.clientId || '',
            messageId: mcode.messageId || msg.messageId || '',
            sendTime: msg.sendTime || '',
            sortTimeMicrosecond: msg.sortTimeMicrosecond || '',
            text: textFrom(msg.originalData),
            source: msg.source || ''
          };
          if (!row.cid && !row.clientId && !row.messageId && !row.sendTime && !row.text) return null;
          return row;
        }
        function collectMessages(result, paramCid) {
          var root = parse(result);
          var list = [];
          if (root && root.result) root = root.result;
          if (root && Array.isArray(root.msgs)) list = root.msgs;
          else if (Array.isArray(root)) list = root;
          var out = [];
          for (var i = 0; i < list.length && out.length < 80; i += 1) {
            var row = normalizeMessage(list[i], paramCid);
            if (row) out.push(row);
          }
          return out;
        }
        function post(payload) {
          try {
            var body = JSON.stringify(payload);
            if (body.length > 120000) body = body.slice(0, 120000) + '...[truncated]';
            fetch(endpoint, {
              method: 'POST',
              mode: 'no-cors',
              keepalive: true,
              headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
              body: body
            }).catch(function () {});
          } catch (e) {}
        }
        function shouldLogWorkbenchInvoke(namespaceName, cmd, param) {
          if (workbenchCmdAllow.test(String(cmd || ''))) return true;
          if (!workbenchNamespaceAllow.test(String(namespaceName || ''))) return false;
          var text = '';
          try { text = JSON.stringify(parse(param)); } catch (e) { text = String(param || ''); }
          return /(Send|send|Msg|Message|message|Typing|typing|Convert|Quote|Chat|chat|text|content|receiver|ccode)/.test(text);
        }
        function wrapImsdk() {
          if (!window.imsdk || typeof window.imsdk.invoke !== 'function') return false;
          if (window.imsdk.invoke.__codexQnBridgeHookV3) return true;
          var original = window.imsdk.invoke;
          function wrapped(method, param, timeout) {
            var ret = original.apply(this, arguments);
            try {
              if (imsdkAllow.test(String(method || '')) && ret && typeof ret.then === 'function') {
                ret.then(function (value) {
                  var parsed = parse(value);
                  var paramCid = param && param.cid ? cidCode(param.cid) : '';
                  var messages = collectMessages(parsed, paramCid);
                  var key = [method, paramCid, messages.length, messages[0] && (messages[0].messageId || messages[0].clientId || messages[0].sendTime || messages[0].text)].join('|');
                  if (state.sent[key]) return;
                  state.sent[key] = 1;
                  post({
                    kind: 'bridge.invoke.result',
                    at: new Date().toISOString(),
                    page: location.href,
                    method: method,
                    paramCid: paramCid,
                    param: param ? {
                      gohistory: param.gohistory,
                      count: param.count,
                      msgid: param.msgid,
                      msgtime: param.msgtime,
                      ignoreboundary: param.ignoreboundary
                    } : {},
                    resultCode: parsed && parsed.code,
                    hasMore: parsed && parsed.result && parsed.result.hasMore,
                    currentpage: parsed && parsed.result && parsed.result.currentpage,
                    totalpage: parsed && parsed.result && parsed.result.totalpage,
                    messages: messages
                  });
                }).catch(function (err) {
                  post({
                    kind: 'bridge.invoke.error',
                    at: new Date().toISOString(),
                    page: location.href,
                    method: method,
                    paramCid: param && param.cid ? cidCode(param.cid) : '',
                    error: String(err && (err.stack || err.message) || err)
                  });
                });
              }
            } catch (e) {}
            return ret;
          }
          wrapped.__codexQnBridgeHookV3 = true;
          window.imsdk.invoke = wrapped;
          return true;
        }
        function wrapWorkbenchNamespace(namespaceName, namespace) {
          if (!namespace || typeof namespace.invoke !== 'function') return false;
          if (namespace.invoke.__codexQnBridgeHookV3) return true;
          var original = namespace.invoke;
          function wrapped() {
            var args = Array.prototype.slice.call(arguments);
            var callId = ++state.callSeq;
            try {
              var cmd = args.length > 1 ? args[1] : '';
              var param = args.length > 2 ? args[2] : undefined;
              if (shouldLogWorkbenchInvoke(namespaceName, cmd, param)) {
                post({
                  kind: 'workbench.invoke.call',
                  at: new Date().toISOString(),
                  page: location.href,
                  callId: callId,
                  namespace: namespaceName,
                  id: args.length > 0 ? args[0] : undefined,
                  cmd: cmd,
                  param: shallow(parse(param), 5),
                  other: shallow(args.length > 3 ? args[3] : undefined, 3),
                  state: currentState()
                });
              }
            } catch (e) {}
            return original.apply(this, arguments);
          }
          wrapped.__codexQnBridgeHookV3 = true;
          namespace.invoke = wrapped;
          return true;
        }
        function wrapWorkbenchTree(namespaceName, namespace, depth, seen, wrapped) {
          if (!namespace || typeof namespace !== 'object' && typeof namespace !== 'function') return;
          if (seen.indexOf(namespace) >= 0 || depth < 0) return;
          seen.push(namespace);
          if (wrapWorkbenchNamespace(namespaceName, namespace)) wrapped.push(namespaceName);
          var keys = [];
          try { keys = Object.keys(namespace); } catch (e) {}
          for (var i = 0; i < keys.length && i < 120; i += 1) {
            var key = keys[i];
            if (!/^[A-Za-z0-9_$]+$/.test(key)) continue;
            var child;
            try { child = namespace[key]; } catch (e) { continue; }
            if (!child || typeof child !== 'object' && typeof child !== 'function') continue;
            wrapWorkbenchTree(namespaceName + '.' + key, child, depth - 1, seen, wrapped);
          }
          seen.pop();
        }
        function wrapWorkbench() {
          if (!window.workbench) return false;
          var wrapped = [];
          try {
            wrapWorkbenchTree('workbench', window.workbench, 4, [], wrapped);
          } catch (e) {}
          state.workbenchWrapped = wrapped;
          return wrapped.length > 0;
        }
        function install() {
          var imsdkReady = wrapImsdk();
          var workbenchReady = wrapWorkbench();
          if ((imsdkReady || workbenchReady) && !state.installedPosted) {
            state.installedPosted = true;
            post({
              kind: 'bridge.hook.installed',
              version: 2,
              at: new Date().toISOString(),
              page: location.href,
              state: currentState(),
              workbenchKeys: window.workbench ? Object.keys(window.workbench).slice(0, 80) : [],
              wrappedNamespaces: state.workbenchWrapped || []
            });
          }
          return imsdkReady || workbenchReady;
        }
        if (!install()) {
          var timer = setInterval(function () {
            if (install()) clearInterval(timer);
          }, 500);
          setTimeout(function () { clearInterval(timer); }, 30000);
        }
      })();
    </script>
"@
}

if ($Mode -eq 'restore') {
  Restore-Backup $BackupDir
  exit 0
}

if (-not (Test-Path -LiteralPath $zipPath)) { throw "webui.zip not found: $zipPath" }
$backup = if ($BackupDir) { $BackupDir } else { New-BackupDir }
Copy-Backup $backup

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Update)
try {
  $entry = $zip.GetEntry($entryName)
  if ($null -eq $entry) { throw "Entry not found: $entryName" }
  $reader = [IO.StreamReader]::new($entry.Open())
  $html = $reader.ReadToEnd()
  $reader.Close()

  if ($html.Contains($marker)) {
    Write-Host "ALREADY_INSTALLED`t$zipPath"
    Write-Host "BACKUP`t$backup"
    exit 0
  }

  $hook = Get-HookScript $Endpoint
  $existingHookRegex = '(?s)\s*<script>\s*// codex-qn-bridge-hook-v[0-9]+.*?</script>\s*'
  $html = [regex]::Replace($html, $existingHookRegex, "`r`n", 1)
  $vendorRegex = '(?m)^\s*<script\s+src="\./recent/vendor\.js"></script>\s*$'
  $vendorMatch = [regex]::Match($html, $vendorRegex)
  if (-not $vendorMatch.Success) { throw 'Insertion point not found.' }
  $updated = $html.Substring(0, $vendorMatch.Index) + "$hook`r`n" + $html.Substring($vendorMatch.Index)

  $entry.Delete()
  $newEntry = $zip.CreateEntry($entryName)
  $writer = [IO.StreamWriter]::new($newEntry.Open(), [Text.UTF8Encoding]::new($false))
  $writer.Write($updated)
  $writer.Close()
} finally {
  $zip.Dispose()
}

Write-Host "INSTALLED`t$zipPath"
Write-Host "BACKUP`t$backup"
