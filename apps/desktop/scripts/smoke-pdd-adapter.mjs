import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { serializedSelectorArgument } from '../electron/platform-workspace/pinduoduo/selectors.js';

const preload = path.resolve(import.meta.dirname, '..', 'electron', 'platform-workspace', 'pinduoduo', 'preload.cjs');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ai-customer-service-pdd-adapter-')));

function fixture() {
  return `<!doctype html>
    <html><head><title>&#x62FC;&#x591A;&#x591A;&#x5BA2;&#x670D;&#x5E73;&#x53F0;</title></head><body data-mall-id="mall-100">
      <div class="LoginUserInfo-mainTitle-text">&#x62FC;&#x591A;&#x591A;&#x5BA2;&#x670D;&#x5E73;&#x53F0;</div>
      <li class="chat-item" id="conversation-a">
        <div class="chat-item-box active" data-random="8715744365612-0-all">
        <span class="chat-nickname">Buyer A</span>
        <span class="bottom-message message-item">Hello again</span>
        <span data-role="unread-count">1</span>
        </div>
      </li>
      <li class="chat-item" style="display: none">
        <div class="chat-item-box" data-random="9922334455667-0-all">
          <span class="chat-nickname">Buyer B</span>
        </div>
      </li>
      <li class="chat-item" id="conversation-b">
        <div class="chat-item-box" data-random="9922334455667-0-all">
        <span class="chat-nickname">Buyer B</span>
        <span class="bottom-message message-item">Second reply</span>
        <span class="SessionBaseCard-unread-rot" style="display: inline-block; width: 8px; height: 8px"></span>
        </div>
      </li>
      <li class="chat-item" style="display: none">
        <div class="chat-item-box" data-random="6677889900112-0-all">
          <span class="chat-nickname">Buyer C</span>
        </div>
      </li>
      <li class="chat-item" id="conversation-c">
        <div class="chat-item-box" data-random="6677889900112-0-all">
        <span class="chat-nickname">Buyer C</span>
        <span class="bottom-message message-item">Another unread message</span>
        <span class="reply-status">&#x5F85;&#x56DE;&#x590D;</span>
        </div>
      </li>
      <main id="message-panel">
        <li id="middlePanel_List_message-a" class="clearfix onemsg">
          <div class="cs-item"><span class="msg-content">First reply</span></div>
        </li>
        <li id="middlePanel_List_message-b" class="clearfix onemsg">
          <span class="message-time">2026&#x5E74;07&#x6708;23&#x65E5; 16:17:38</span>
          <img class="avatar" src="https://savatar.pddpic.com/avatar.png">
          <div class="buyer-item"><span class="msg-content">Battery capacity?</span></div>
        </li>
        <li id="middlePanel_List_lead" class="clearfix onemsg">
          <div class="BuyerFromCard"><span class="msg-content">Lead card</span></div>
        </li>
        <li id="middlePanel_List_notice" class="clearfix onemsg">
          <div class="msg-system"><span class="msg-content">System notice</span></div>
        </li>
        <li id="middlePanel_List_message-c" class="clearfix onemsg">
          <div class="cs-item"><span class="msg-content">Second reply</span></div>
        </li>
        <li id="middlePanel_List_message-d" class="clearfix onemsg">
          <span class="message-time">2026&#x5E74;07&#x6708;25&#x65E5; 15:19</span>
          <div class="buyer-item"><span class="msg-content">Hello again</span></div>
        </li>
      </main>
      <textarea id="replyTextarea"></textarea>
      <button id="replySendButton">发送</button>
      <script>
        setTimeout(() => {
          document.title = 'Test store';
        }, 300);
        function recordSwitch(id) {
          document.body.dataset.switchCount = String(Number(document.body.dataset.switchCount || '0') + 1);
          document.body.dataset.switchLog = [document.body.dataset.switchLog, id].filter(Boolean).join(',');
        }
        function activateConversation(id, messageId, content) {
          recordSwitch(id);
          document.querySelectorAll('.chat-item-box').forEach((item) => item.classList.remove('active'));
          document.querySelector('#' + id + ' .chat-item-box').classList.add('active');
          document.querySelector('#message-panel').innerHTML = [
            '<li id="' + messageId + '" class="clearfix onemsg">',
            '<span class="message-time">2026&#x5E74;07&#x6708;28&#x65E5; 14:30:00</span>',
            '<div class="buyer-item"><span class="msg-content">' + content + '</span></div>',
            '</li>'
          ].join('');
        }
        document.querySelector('#conversation-a').addEventListener('click', () => {
          recordSwitch('conversation-a');
        });
        document.querySelector('#conversation-b').addEventListener('click', () => {
          const followUp = document.body.dataset.buyerBVersion === '2';
          activateConversation(
            'conversation-b',
            followUp ? 'middlePanel_List_b-follow-up' : 'middlePanel_List_b-message',
            followUp ? 'Follow-up from Buyer B' : 'Message from Buyer B',
          );
        });
        document.querySelector('#conversation-c').addEventListener('click', () => {
          activateConversation('conversation-c', 'middlePanel_List_c-message', 'Message from Buyer C');
        });
        document.querySelector('#replySendButton').addEventListener('click', () => {
          if (document.body.dataset.forceEnter !== '1') {
            document.querySelector('#replyTextarea').value = '';
          }
        });
        document.querySelector('#replyTextarea').addEventListener('keydown', (event) => {
          if (event.key === 'Enter') document.querySelector('#replyTextarea').value = '';
        });
      </script>
    </body></html>`;
}

function failedSwitchFixture() {
  return `<!doctype html>
    <html><head><title>Failed switch fixture</title></head><body data-mall-id="mall-200">
      <div data-role="shop-name">Failure test store</div>
      <li class="chat-item">
        <div class="chat-item-box active" data-random="failure-a-0-all">
          <span class="chat-nickname">Failure Buyer A</span>
        </div>
      </li>
      <li class="chat-item" id="failed-target">
        <div class="chat-item-box" data-random="failure-b-0-all">
          <span class="chat-nickname">Failure Buyer B</span>
          <span data-role="unread-count">1</span>
        </div>
      </li>
      <main>
        <li id="middlePanel_List_failure-a-message" class="clearfix onemsg">
          <div class="buyer-item"><span class="msg-content">Message that belongs to Failure Buyer A</span></div>
        </li>
      </main>
      <script>
        document.querySelector('#failed-target').addEventListener('click', () => {
          document.body.dataset.failedClicks = String(Number(document.body.dataset.failedClicks || '0') + 1);
        });
      </script>
    </body></html>`;
}

app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url?.includes('failed-switch') ? failedSwitchFixture() : fixture());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [serializedSelectorArgument()],
    },
  });
  const messages = [];
  // The production workspace manager turns preload requests into serial store-actor commands.
  let unreadRequestSequence = 0;
  let unreadCollectionBusy = false;
  const requestUnreadCollection = () => {
    if (unreadCollectionBusy) return;
    unreadCollectionBusy = true;
    unreadRequestSequence += 1;
    window.webContents.send('pdd-adapter:command', {
      type: 'collect-next-unread',
      requestId: `adapter-smoke-unread-${unreadRequestSequence}`,
    });
  };
  window.webContents.on('ipc-message', (_event, channel, payload) => {
    if (channel !== 'pdd-adapter:event') return;
    messages.push(payload);
    if (payload.type === 'collect_unread_request') {
      requestUnreadCollection();
    }
    if (payload.type === 'unread_collection_result') {
      unreadCollectionBusy = false;
      if (payload.status === 'collected') setTimeout(requestUnreadCollection, 25);
    }
  });
  await window.loadURL(`http://127.0.0.1:${address.port}/chat-merchant/index.html`);

  const buyerBSnapshot = () => messages.find((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.external_conversation_id === '9922334455667'
      && conversation.active
      && conversation.messages?.some((message) => message.platform_message_id === 'middlePanel_List_b-message')
    ))
  ));
  const buyerCSnapshot = () => messages.find((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.external_conversation_id === '6677889900112'
      && conversation.active
      && conversation.messages?.some((message) => message.platform_message_id === 'middlePanel_List_c-message')
    ))
  ));
  const buyerBFollowUpSnapshot = () => messages.find((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.external_conversation_id === '9922334455667'
      && conversation.active
      && conversation.messages?.some((message) => message.platform_message_id === 'middlePanel_List_b-follow-up')
    ))
  ));
  const storeIdentity = () => messages.find((item) => (
    item.type === 'identity' && item.account_name === 'Test store'
  ));
  const deadline = Date.now() + 8000;
  while ((!buyerBSnapshot() || !buyerCSnapshot() || !storeIdentity()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const status = messages.find((item) => item.type === 'status');
  const identity = storeIdentity();
  const snapshot = messages.find((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.external_conversation_id === '8715744365612'
      && conversation.messages?.length === 4
    ))
  ));
  const unreadSnapshot = buyerBSnapshot();
  const secondUnreadSnapshot = buyerCSnapshot();
  assert.equal(status?.status, 'online');
  assert.equal(identity?.external_account_id, 'mall-100');
  assert.equal(identity?.account_name, 'Test store');
  assert.equal(identity?.account_name_source, 'document_title');
  assert.equal(
    messages.some((item) => item.type === 'identity' && item.account_name === '拼多多客服平台'),
    false,
    'a generic platform title must never be emitted as the store name',
  );
  const detectionRequestId = 'adapter-smoke-name-detection';
  window.webContents.send('pdd-adapter:command', {
    type: 'detect-account-name',
    requestId: detectionRequestId,
  });
  const detectionDeadline = Date.now() + 2000;
  while (
    !messages.some((item) => (
      item.type === 'account_name_detection' && item.request_id === detectionRequestId
    ))
    && Date.now() < detectionDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const manualDetection = messages.find((item) => (
    item.type === 'account_name_detection' && item.request_id === detectionRequestId
  ));
  assert.equal(manualDetection?.account_name, 'Test store');
  assert.equal(manualDetection?.source, 'document_title');
  const initialConversation = snapshot?.conversations?.find(
    (conversation) => conversation.external_conversation_id === '8715744365612',
  );
  assert.ok(initialConversation, 'initial active conversation snapshot must be collected');
  const collected = initialConversation.messages || [];
  assert.equal(
    collected.length,
    4,
    'conversation previews, lead cards, and system nodes must be filtered',
  );
  assert.equal(
    collected.filter((item) => item.content === 'Hello again').length,
    1,
    'a preview that duplicates the newest real message must not create an early occurrence',
  );
  assert.equal(
    collected.filter((item) => item.content === 'Second reply').length,
    1,
    'another conversation preview must not duplicate a historical agent message',
  );
  assert.equal(
    collected.some((item) => item.content === 'Another unread message'),
    false,
    'unrelated conversation-list previews must never be read as active-chat messages',
  );
  assert.deepEqual(
    collected.map((item) => item.platform_message_id),
    [
      'middlePanel_List_message-a',
      'middlePanel_List_message-b',
      'middlePanel_List_message-c',
      'middlePanel_List_message-d',
    ],
  );
  assert.deepEqual(collected.map((item) => item.snapshot_sequence), [0, 1, 4, 5]);
  assert.equal(collected[0].sender_role, 'agent');
  assert.equal(collected[1].sender_role, 'customer');
  assert.equal(collected[1].message_type, 'text', 'avatar must not turn text into an image message');
  assert.equal(collected[0].platform_sent_at, collected[1].platform_sent_at, 'leading message inherits first time anchor');
  assert.equal(collected[1].platform_sent_at, collected[2].platform_sent_at, 'messages inherit the active time group');
  assert.notEqual(collected[2].platform_sent_at, collected[3].platform_sent_at);
  assert.deepEqual(collected.map((item) => item.time_group_index), [0, 0, 0, 1]);
  assert.deepEqual(collected.map((item) => item.has_explicit_time), [false, true, false, true]);
  assert.deepEqual(
    initialConversation.snapshot_messages.map((item) => item.platform_message_id),
    [
      'middlePanel_List_message-a',
      'middlePanel_List_message-b',
      'middlePanel_List_message-c',
      'middlePanel_List_message-d',
    ],
  );
  assert.deepEqual(
    initialConversation.snapshot_messages.map((item) => item.dom_sequence),
    [0, 1, 2, 3],
    'shadow snapshot sequence must remain continuous after system-node filtering',
  );
  assert.equal(initialConversation.snapshot_messages[0].platform_sent_at, undefined);
  assert.equal(initialConversation.snapshot_messages[0].time_label, undefined);
  assert.ok(snapshot.snapshot_id);
  const buyerB = unreadSnapshot?.conversations?.find(
    (conversation) => conversation.external_conversation_id === '9922334455667',
  );
  assert.ok(buyerB?.active, 'unread conversation must be verified as active before collection');
  assert.deepEqual(
    buyerB.messages.map((message) => message.platform_message_id),
    ['middlePanel_List_b-message'],
  );
  assert.equal(buyerB.messages[0].content, 'Message from Buyer B');
  assert.ok(
    !buyerB.messages.some((message) => collected.some((initial) => initial.platform_message_id === message.platform_message_id)),
    'messages from the previous conversation must never be attached to the unread target',
  );
  const buyerC = secondUnreadSnapshot?.conversations?.find(
    (conversation) => conversation.external_conversation_id === '6677889900112',
  );
  assert.ok(buyerC?.active, 'the next unread conversation must be processed serially');
  assert.deepEqual(
    buyerC.messages.map((message) => message.platform_message_id),
    ['middlePanel_List_c-message'],
  );
  assert.equal(buyerC.messages[0].content, 'Message from Buyer C');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const initialSwitchCount = await window.webContents.executeJavaScript('document.body.dataset.switchCount');
  const initialSwitchLog = await window.webContents.executeJavaScript('document.body.dataset.switchLog');
  assert.equal(initialSwitchCount, '3', 'persistent unread previews must not be processed repeatedly');
  assert.equal(
    initialSwitchLog,
    'conversation-a,conversation-b,conversation-c',
    'the already-active unread conversation must still be clicked first',
  );

  await window.webContents.executeJavaScript(`
    document.body.dataset.buyerBVersion = '2';
    document.querySelector('#conversation-b .bottom-message').textContent = 'Follow-up message';
  `);
  const followUpDeadline = Date.now() + 5000;
  while (!buyerBFollowUpSnapshot() && Date.now() < followUpDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const followUpSnapshot = buyerBFollowUpSnapshot();
  assert.ok(followUpSnapshot, 'a changed unread preview must trigger collection again');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const switchCount = await window.webContents.executeJavaScript('document.body.dataset.switchCount');
  const switchLog = await window.webContents.executeJavaScript('document.body.dataset.switchLog');
  assert.equal(switchCount, '4', 'an unchanged persistent unread preview must remain handled');
  assert.equal(switchLog, 'conversation-a,conversation-b,conversation-c,conversation-b');
  const diagnosticStages = messages
    .filter((item) => item.type === 'diagnostic')
    .map((item) => item.stage);
  assert.ok(
    diagnosticStages.includes('conversation_scan_completed'),
    'conversation scanning must emit diagnostic details',
  );
  assert.ok(
    diagnosticStages.includes('unread_click_dispatched'),
    'an unread switch click must be logged',
  );
  assert.ok(
    diagnosticStages.includes('switch_verification_succeeded'),
    'a verified unread switch must be logged',
  );

  const sendRequestId = 'adapter-smoke-send-message';
  window.webContents.send('pdd-adapter:command', {
    type: 'send-message',
    requestId: sendRequestId,
    conversationKey: '9922334455667',
    customerName: 'Buyer B',
    content: '点击发送验收消息',
  });
  const prepareDeadline = Date.now() + 7000;
  while (
    !messages.some((item) => item.type === 'message_send_result' && item.request_id === sendRequestId)
    && Date.now() < prepareDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const sendResult = messages.find((item) => (
    item.type === 'message_send_result' && item.request_id === sendRequestId
  ));
  assert.equal(sendResult?.status, 'sent', 'message must be sent by the platform button');
  assert.equal(sendResult?.method, 'click');
  assert.equal(sendResult?.conversation_key, '9922334455667');
  const sentText = await window.webContents.executeJavaScript('document.querySelector("#replyTextarea").value');
  assert.equal(sentText, '');
  assert.equal(
    messages.some((item) => item.type === 'message_send_result' && item.status === 'failed'),
    false,
    'button send must not fail before the Enter fallback test',
  );

  await window.webContents.executeJavaScript("document.body.dataset.forceEnter = '1'");
  const enterRequestId = 'adapter-smoke-send-message-enter-fallback';
  window.webContents.send('pdd-adapter:command', {
    type: 'send-message',
    requestId: enterRequestId,
    conversationKey: '9922334455667',
    customerName: 'Buyer B',
    content: 'Enter 兜底验收消息',
  });
  const enterDeadline = Date.now() + 7000;
  while (
    !messages.some((item) => item.type === 'message_send_result' && item.request_id === enterRequestId)
    && Date.now() < enterDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const enterResult = messages.find((item) => (
    item.type === 'message_send_result' && item.request_id === enterRequestId
  ));
  assert.equal(enterResult?.status, 'sent', 'Enter fallback must send when button does not clear input');
  assert.equal(enterResult?.method, 'enter');

  const failedWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [serializedSelectorArgument()],
    },
  });
  const failedEvents = [];
  failedWindow.webContents.on('ipc-message', (_event, channel, payload) => {
    if (channel !== 'pdd-adapter:event') return;
    failedEvents.push(payload);
    if (payload.type === 'collect_unread_request') {
      failedWindow.webContents.send('pdd-adapter:command', {
        type: 'collect-next-unread',
        requestId: 'adapter-smoke-failed-unread',
      });
    }
  });
  await failedWindow.loadURL(`http://127.0.0.1:${address.port}/chat-merchant/failed-switch`);
  await new Promise((resolve) => setTimeout(resolve, 4500));
  const incorrectlyBound = failedEvents.some((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.customer_name === 'Failure Buyer B'
      && conversation.messages?.some((message) => message.platform_message_id === 'middlePanel_List_failure-a-message')
    ))
  ));
  assert.equal(incorrectlyBound, false, 'an unverified switch must never emit messages for the target');
  const currentConversationCollected = failedEvents.some((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.customer_name === 'Failure Buyer A'
      && conversation.messages?.some((message) => (
        message.platform_message_id === 'middlePanel_List_failure-a-message'
      ))
    ))
  ));
  assert.equal(
    currentConversationCollected,
    false,
    'the current readable conversation must not be collected before an unread switch is verified',
  );
  const failedClicks = await failedWindow.webContents.executeJavaScript('document.body.dataset.failedClicks');
  assert.equal(failedClicks, '1');
  assert.ok(
    failedEvents.some((item) => (
      item.type === 'diagnostic' && item.stage === 'switch_verification_timed_out'
    )),
    'a failed unread switch verification must be logged',
  );
  failedWindow.destroy();

  console.log(JSON.stringify({
    status: 'passed',
    adapter_events: messages.length,
    unread_switches: 4,
    preview_change_reprocessed: true,
    failed_switch_blocked: true,
  }));
  window.destroy();
  await new Promise((resolve) => server.close(resolve));
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
