(function (root) {
  'use strict';
  var NEW_MESSAGE_EVENT = 'im.singlemsg.onShopRobotReceriveNewMsgs';
  var SEND_RECEIPT_EVENT = 'im.singlemsg.onMsgSendUpdate';
  var NOTICE_ENDPOINT = 'http://127.0.0.1:18082/qn-bridge/notice';
  var SEND_RECEIPT_ENDPOINT = 'http://127.0.0.1:18082/qn-bridge/send-receipt';

  function stringField(value, limit) {
    if (value == null) return '';
    var text = String(value);
    return text.length <= limit ? text : '';
  }

  function parseValue(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (error) { return null; }
  }

  function noticeItems(value) {
    var rows = parseValue(value);
    if (!Array.isArray(rows)) rows = rows && Array.isArray(rows.result) ? rows.result : [];
    var items = [];
    for (var i = 0; i < rows.length && items.length < 20; i += 1) {
      var row = rows[i] || {}, cid = row.cid || {}, messages = Array.isArray(row.newmsgs) ? row.newmsgs : [];
      for (var j = 0; j < messages.length && items.length < 20; j += 1) {
        var msg = messages[j] || {}, mcode = msg.mcode || {}, from = msg.fromId || {}, to = msg.toId || {};
        items.push({
          cid: stringField(cid.ccode, 256),
          buyerNick: stringField(cid.nick, 128),
          buyerUid: stringField(cid.targetId, 128),
          messageId: stringField(mcode.messageId, 128),
          messageClientId: stringField(mcode.clientId, 128),
          sendTime: stringField(msg.sendTime, 64),
          fromId: stringField(from.targetId, 128),
          toId: stringField(to.targetId, 128)
        });
      }
    }
    return items;
  }

  function installNewMessageListener(env, options) {
    options = options || {};
    if (!env || env.__codexQnNewMessageListenerV1) return false;
    if (!env.imsdk || typeof env.imsdk.on !== 'function') return false;
    var fetchFn = options.fetch || env.fetch;
    if (typeof fetchFn !== 'function') return false;
    var endpoint = options.endpoint || NOTICE_ENDPOINT;
    env.__codexQnNewMessageListenerV1 = { installedAt: Date.now() };
    env.imsdk.on(NEW_MESSAGE_EVENT, function (value) {
      var bridge = env.__codexQnBridgeHookV8 || {};
      var items = noticeItems(value);
      if (!bridge.clientId || !items.length) return;
      var body = JSON.stringify({
        kind: 'bridge.message.notice',
        eventName: NEW_MESSAGE_EVENT,
        clientId: bridge.clientId,
        at: new Date().toISOString(),
        items: items
      });
      fetchFn.call(env, endpoint, {
        method: 'POST', mode: 'no-cors', keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: body
      }).catch(function () {});
    });
    return true;
  }

  function sendReceiptItems(value) {
    var rows = parseValue(value);
    if (!Array.isArray(rows)) rows = rows && Array.isArray(rows.result) ? rows.result : [];
    var items = [];
    for (var i = 0; i < rows.length && items.length < 20; i += 1) {
      var row = rows[i] || {}, cid = row.cid || {}, mcode = row.mcode || {}, original = row.originalData || {};
      if (!Number.isInteger(row.sendStatus) || !Number.isInteger(row.progress)) continue;
      items.push({
        cid: stringField(cid.ccode, 256),
        clientId: stringField(mcode.clientId, 128),
        messageId: stringField(mcode.messageId, 128),
        text: stringField(original.text, 4095),
        sendStatus: row.sendStatus,
        progress: row.progress,
        sendTime: stringField(row.sendTime, 64)
      });
    }
    return items;
  }

  function installSendReceiptListener(env, options) {
    options = options || {};
    if (!env || env.__codexQnSendReceiptListenerV1) return false;
    if (!env.imsdk || typeof env.imsdk.on !== 'function') return false;
    var fetchFn = options.fetch || env.fetch;
    if (typeof fetchFn !== 'function') return false;
    var endpoint = options.endpoint || SEND_RECEIPT_ENDPOINT;
    env.__codexQnSendReceiptListenerV1 = { installedAt: Date.now() };
    env.imsdk.on(SEND_RECEIPT_EVENT, function (value) {
      var bridge = env.__codexQnBridgeHookV8 || {};
      var items = sendReceiptItems(value);
      if (!bridge.clientId || !items.length) return;
      fetchFn.call(env, endpoint, {
        method: 'POST', mode: 'no-cors', keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({
          kind: 'bridge.send.receipt',
          eventName: SEND_RECEIPT_EVENT,
          clientId: bridge.clientId,
          at: new Date().toISOString(),
          items: items
        })
      }).catch(function () {});
    });
    return true;
  }

  function scheduleNewMessageListener(env) {
    if (!env || typeof env.setInterval !== 'function') return;
    if (installNewMessageListener(env) && installSendReceiptListener(env)) return;
    var attempts = 0;
    var timer = env.setInterval(function () {
      attempts += 1;
      var incomingReady = Boolean(env.__codexQnNewMessageListenerV1) || installNewMessageListener(env);
      var receiptReady = Boolean(env.__codexQnSendReceiptListenerV1) || installSendReceiptListener(env);
      if (incomingReady && receiptReady || attempts >= 120) env.clearInterval(timer);
    }, 500);
  }

  function createReader(env) {
    return function readMessages(param) {
      return Promise.resolve().then(function () {
        param = param || {};
        var shopUid = param.shopUid, cid = param.cid;
        var count = param.count == null ? 20 : param.count;
        if (typeof shopUid !== 'string' || !/^\d+$/.test(shopUid) || typeof cid !== 'string' ||
            !Number.isInteger(count) || count < 1 || count > 20) throw new Error('invalid readMessages parameters');
        var match = /^(\d+)\.1-(\d+)\.1#11001@cntaobao$/.exec(cid);
        if (!match) throw new Error('only single taobao conversations are supported');
        var state = env._vs || {}, login = state.loginID || {};
        if (String(login.targetId || '') !== shopUid) throw new Error('shop account mismatch');
        var mainId = String(login.havMainId || '');
        if (!mainId || match[1] !== mainId && match[2] !== mainId) throw new Error('cid does not belong to shop main account');
        var targetId = match[1] === mainId ? match[2] : match[1];
        var before = state.conversationID && state.conversationID.ccode || '';
        if (!env.imsdk || typeof env.imsdk.invoke !== 'function') throw new Error('imsdk unavailable');
        // Invoke only the history primitive. Do not use UI rendering/middleware helpers.
        return env.imsdk.invoke('im.singlemsg.GetLocalHisMsg', {
          cid: { ccode: cid, ctype: 0, targetType: '3', targetId: targetId, bizeType: '11001' },
          gohistory: 1, count: count
        }, 15000).then(function (value) {
          var after = env._vs || {}, afterLogin = after.loginID || {};
          if (String(afterLogin.targetId || '') !== shopUid || String(afterLogin.havMainId || '') !== mainId)
            throw new Error('shop changed during read');
          var response = typeof value === 'string' ? JSON.parse(value) : value;
          if (!response || typeof response !== 'object') throw new Error('invalid history response');
          if (response.code != null && Number(response.code) !== 0) throw new Error('history error: ' + JSON.stringify(response));
          var result = response.result == null ? response : response.result;
          if (typeof result === 'string') result = JSON.parse(result);
          var rows = Array.isArray(result) ? result : result && result.msgs;
          if (!Array.isArray(rows) || rows.length > count) throw new Error('unexpected history message list');
          var messages = rows.map(function (msg) {
            var actualCid = typeof msg.cid === 'string' ? msg.cid : msg.cid && msg.cid.ccode;
            if (actualCid && actualCid !== cid) throw new Error('response contains a different cid');
            if (msg.loginid && msg.loginid.targetId && String(msg.loginid.targetId) !== shopUid &&
                String(msg.loginid.targetId) !== mainId) throw new Error('response contains a different login account');
            var from = msg.fromid || msg.fromId || {}, to = msg.toid || msg.toId || {};
            var fromId = String(from.targetId || ''), toId = String(to.targetId || '');
            var outgoing = fromId === shopUid || fromId === mainId;
            var incoming = toId === shopUid || toId === mainId;
            var original = msg.originalData || {}, text = typeof original.text === 'string' ? original.text : '';
            if (!text && Array.isArray(original.jsview)) {
              for (var i = 0; i < original.jsview.length; ++i) {
                var v = original.jsview[i] && original.jsview[i].value;
                if (v && typeof v.text === 'string') { text = v.text; break; }
              }
            }
            var mcode = msg.mcode || {};
            function field(value, limit) {
              if (typeof value !== 'string') return undefined;
              if (value.length > limit) throw new Error('message media field too large');
              return value;
            }
            var media = { text: field(original.text, 16000), url: field(original.url, 8192),
              width: original.width, height: original.height };
            if (Array.isArray(original.jsview)) {
              if (original.jsview.length > 32) throw new Error('too many message parts');
              media.jsview = original.jsview.map(function (node) {
                var v = node && node.value || {};
                return { type: node && node.type, value: { text: field(v.text, 16000), url: field(v.url, 8192), urlinfo: field(v.urlinfo, 16000) } };
              });
            }
            // Template messages carry their card body outside the text JSView nodes.
            var templateData;
            if (msg.templateId === 129) {
              var templateJson = JSON.stringify({ originalData: original,
                dynamicContent: msg.ext && msg.ext.dynamic_msg_content });
              if (templateJson.length > 64000) throw new Error('template message too large');
              templateData = JSON.parse(templateJson);
            }
            function id(value) {
              if (value == null || value === '') return '';
              if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('lossy numeric message ID');
              return String(value);
            }
            return { shopUid: shopUid, cid: cid, messageId: id(mcode.messageId || msg.messageId),
              clientId: id(mcode.clientId || msg.clientId), direction: outgoing ? 'outgoing' : incoming ? 'incoming' : 'unknown',
              fromId: fromId, fromNick: from.nick || '', toId: toId, toNick: to.nick || '',
              text: text, sendTime: msg.sendTime == null ? null : msg.sendTime,
              mediaVersion: 1, templateId: msg.templateId, originalData: media, templateData: templateData,
              sortTimeMicrosecond: msg.sortTimeMicrosecond == null ? null : msg.sortTimeMicrosecond };
          });
          var output = { shopUid: shopUid, cid: cid, method: 'im.singlemsg.GetLocalHisMsg', count: messages.length,
            hasMore: typeof result.hasMore === 'boolean' ? result.hasMore : null, messages: messages,
            currentCidBefore: before, currentCidAfter: after.conversationID && after.conversationID.ccode || '' };
          output.mediaVersion = 1;
          if (JSON.stringify(output).length > 256000) throw new Error('message page too large; use a smaller count');
          return output;
        });
      });
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = {
    createReader: createReader,
    installNewMessageListener: installNewMessageListener,
    installSendReceiptListener: installSendReceiptListener,
    noticeItems: noticeItems,
    sendReceiptItems: sendReceiptItems,
    NEW_MESSAGE_EVENT: NEW_MESSAGE_EVENT,
    SEND_RECEIPT_EVENT: SEND_RECEIPT_EVENT
  };
  else {
    root.__codexQnReadMessages = createReader(root);
    scheduleNewMessageListener(root);
  }
})(typeof window === 'object' ? window : globalThis);
