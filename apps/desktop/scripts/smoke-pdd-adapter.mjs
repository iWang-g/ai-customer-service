import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
          <div class="cs-item"><span class="msg-content">First line<br>Second line</span></div>
        </li>
        <li id="middlePanel_List_message-b" class="clearfix onemsg">
          <span class="message-time">2026&#x5E74;07&#x6708;23&#x65E5; 16:17:38</span>
          <img class="avatar" src="https://savatar.pddpic.com/avatar.png">
          <div class="buyer-item"><span class="msg-content">Battery capacity?</span></div>
        </li>
        <li id="middlePanel_List_lead" class="clearfix onemsg">
          <div class="BuyerFromCard"><span class="msg-content">
            <span>当前用户来自 商品详情页</span><br>
            <span>来源商品标题</span><br>
            <span>￥10.00</span>
          </span></div>
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
        <li id="middlePanel_List_product" class="clearfix onemsg">
          <span class="message-time">2026&#x5E74;08&#x6708;14&#x65E5; 09:24:36</span>
          <div class="buyer-item"><div class="msg-content">
            <div>商品ID：970947366369</div><div>复制</div>
            <img src="https://img.example.com/product.jpeg">
            <div>水杯古风床头新款小众彩绘三层正宗3d打印网红</div>
            <div>￥10 /2人团</div><div>查看商品规格</div>
          </div></div>
        </li>
        <li id="middlePanel_List_agent-product-reference" class="clearfix onemsg">
          <div class="cs-item"><span class="msg-content">亲亲，您咨询的商品ID 970947366369 暂时无法确认库存，我帮您进一步核实。</span></div>
        </li>
      </main>
      <aside class="right-panel-container">
        <button class="LatestOrder">最新订单</button>
        <button class="PersonalOrder bar-select" aria-selected="true">个人订单</button>
        <div>全部 未完成 待发货 待签收 已签收 退款中</div>
        <div>3年内无订单</div>
      </aside>
      <textarea id="replyTextarea"></textarea>
      <button id="replySendButton">发送</button>
      <script>
        setTimeout(() => {
          document.title = 'Test store';
        }, 5500);
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
  const chatListRequests = [];
  const syncMessageRequests = [];
  const sendMessageRequests = [];
  const server = http.createServer((request, response) => {
    if (request.url?.includes('/janus/api/customService/queryCustomServiceInfo')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        success: true,
        errorCode: 1000000,
        errorMsg: null,
        result: {
          customServiceInfo: null,
          mallInfoResult: {
            mallId: 688523141,
            logo: 'https://img.pddpic.com/store-logo.png',
            mallName: 'API Test store',
          },
        },
      }));
      return;
    }
    if (request.url?.includes('/chats/userinfo/realtime')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        success: true,
        mall_id: 688523141,
        cs_id: '688523141',
        username: '主账号',
        mall: {
          mall_id: 688523141,
          mall_name: 'API Test store',
          logo: 'https://img.pddpic.com/store-logo.png',
        },
      }));
      return;
    }
    if (request.url?.includes('/plateau/chat/latest_conversations')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        success: true,
        result: {
          response: 'latest_conversations',
          result: 'ok',
          has_more: false,
          page: 1,
          size: 100,
          conversations: [{
            to: { role: 'user', uid: '8715744365612' },
            from: { role: 'mall_cs', uid: '688523141', mall_id: '688523141' },
            content: 'Hello again',
            type: 0,
            msg_id: '1786955732373',
            mallName: 'API Test store',
            user_info: {
              uid: 8715744365612,
              nickname: 'Buyer A',
              avatar: 'https://savatar.pddpic.com/avatar.png',
            },
          }],
        },
      }));
      return;
    }
    if (request.url?.includes('/plateau/chat/list')) {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        chatListRequests.push({
          headers: request.headers,
          body: parsed,
        });
        const customerUid = parsed?.data?.list?.with?.id || 'unknown';
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          success: true,
          result: {
            response: 'list',
            result: 'ok',
            has_more: false,
            read_mark: {
              user_last_read: '1786953946927',
              min_supported_msg_id: '1588908282573',
            },
            messages: [
              {
                to: { role: 'user', uid: customerUid },
                from: { role: 'mall_cs', uid: '688523141', mall_id: '688523141' },
                ts: '1786955732',
                content: 'API agent reply',
                type: 0,
                msg_id: '1786955732373',
                pre_msg_id: '1786955420775',
                status: 'read',
              },
              {
                from: { uid: customerUid, role: 'user' },
                to: { uid: '688523141', role: 'mall_cs' },
                content: 'API customer message',
                type: 0,
                ts: '1786955420',
                msg_id: '1786955420775',
                pre_msg_id: '1786953946927',
                status: 'unread',
              },
            ],
          },
        }));
      });
      return;
    }
    if (request.url?.includes('pre_upload')) {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          success: true,
          result: {
            response: 'pre_upload',
            result: 'ok',
            request_id: parsed?.request_id || 1787204151000,
            upload_token: 'smoke-upload-token',
            upload_url: `http://${request.headers.host}/dynamic-image-upload`,
            upload_host: `http://${request.headers.host}`,
            store_url: '/plateau/chat/store_image',
          },
        }));
      });
      return;
    }
    if (request.url?.includes('dynamic-image-upload')) {
      request.resume();
      request.on('end', () => {
        response.writeHead(204, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('');
      });
      return;
    }
    if (request.url?.includes('store_image')) {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          success: true,
          result: {
            response: 'store_image',
            result: 'ok',
            url: 'https://chat-img.pddugc.com/chat-pic-mall-cs-v1/2026-08-20/smoke.jpeg',
            hash: 'smoke-image-hash',
            size: {
              width: 1170,
              height: 1550,
              image_size: 89,
            },
            info: {
              thumb_data: 'data:image/jpeg;base64,AAAA',
            },
          },
        }));
      });
      return;
    }
    if (request.url?.includes('/plateau/chat/send_message')) {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        sendMessageRequests.push({
          headers: request.headers,
          body: parsed,
        });
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          success: true,
          result: {
            response: 'send_message',
            request_id: parsed?.data?.request_id || 1787031726880,
            result: 'ok',
            msg_id: 1787031727088,
            pre_msg_id: '1786933622874',
            ts: 1787031727,
          },
        }));
      });
      return;
    }
    if (request.url?.includes('/plateau/sync/message')) {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        syncMessageRequests.push({
          headers: request.headers,
          body: parsed,
        });
        const seqId = Number(parsed?.sync_key?.[0]?.seq_id) || 0;
        const nextSeqId = seqId < 11 ? 11 : 12;
        const messageId = seqId < 11 ? 'sync-native-message' : 'sync-poll-message';
        const content = seqId < 11 ? 'Native sync customer message' : 'Polled sync customer message';
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          success: true,
          result: {
            sync_data: [{
              seq_type: 1,
              seq_id: nextSeqId,
              data: [{
                message: {
                  from: { uid: '9922334455667', role: 'user' },
                  to: { uid: '688523141', role: 'mall_cs' },
                  content,
                  type: 0,
                  ts: String(1786955400 + nextSeqId),
                  msg_id: messageId,
                  pre_msg_id: '1786953946927',
                },
              }],
            }],
            server_time: 1786955400000 + nextSeqId,
          },
        }));
      });
      return;
    }
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
  await window.webContents.executeJavaScript(`
    fetch('/plateau/chat/latest_conversations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anti-content': 'test-anti-content',
      },
      body: JSON.stringify({
        data: {
          cmd: 'latest_conversations',
          anti_content: 'test-body-anti-content',
        },
        client: 'WEB',
        anti_content: 'test-body-anti-content',
      }),
    }).then((response) => response.json())
  `);
  await window.webContents.executeJavaScript(`
    fetch('/plateau/sync/message', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anti-content': 'test-anti-content',
      },
      body: JSON.stringify({
        sync_key: [{ seq_id: 10, seq_type: 1 }],
        anti_content: 'test-body-anti-content',
      }),
    }).then((response) => response.json())
  `);

  const buyerBSnapshot = () => messages.find((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.external_conversation_id === '9922334455667'
      && conversation.active
      && conversation.snapshot_messages?.some((message) => message.platform_message_id === 'middlePanel_List_b-message')
    ))
  ));
  const buyerCSnapshot = () => messages.find((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.external_conversation_id === '6677889900112'
      && conversation.active
      && conversation.snapshot_messages?.some((message) => message.platform_message_id === 'middlePanel_List_c-message')
    ))
  ));
  const buyerBFollowUpSnapshot = () => messages.find((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.external_conversation_id === '9922334455667'
      && conversation.active
      && conversation.snapshot_messages?.some((message) => message.platform_message_id === 'middlePanel_List_b-follow-up')
    ))
  ));
  const storeIdentity = () => messages.find((item) => (
    item.type === 'identity' && item.account_name === 'API Test store'
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
      && conversation.snapshot_messages?.length === 8
    ))
  ));
  const unreadSnapshot = buyerBSnapshot();
  const secondUnreadSnapshot = buyerCSnapshot();
  assert.equal(status?.status, 'online');
  assert.equal(identity?.external_account_id, '688523141');
  assert.equal(identity?.account_name, 'API Test store');
  assert.equal(identity?.account_name_source, 'pdd_api_custom_service_info');
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
  assert.equal(manualDetection?.account_name, 'API Test store');
  assert.equal(manualDetection?.source, 'pdd_api_custom_service_info');

  const latestCandidatesRequestId = 'adapter-smoke-latest-candidates';
  window.webContents.send('pdd-adapter:command', {
    type: 'list-conversations-api',
    requestId: latestCandidatesRequestId,
  });
  const latestCandidatesDeadline = Date.now() + 2000;
  while (
    !messages.some((item) => (
      item.type === 'api_latest_conversations_result' && item.request_id === latestCandidatesRequestId
    ))
    && Date.now() < latestCandidatesDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const latestCandidates = messages.find((item) => (
    item.type === 'api_latest_conversations_result' && item.request_id === latestCandidatesRequestId
  ));
  assert.equal(latestCandidates?.status, 'collected');
  assert.ok(
    latestCandidates?.response?.result?.conversations?.some((conversation) => (
      String(conversation?.user_info?.uid) === '8715744365612'
      && conversation?.mallName === 'API Test store'
      && conversation?.user_info?.nickname === 'Buyer A'
      && conversation?.content === 'Hello again'
    )),
    'list-conversations-api must return latest_conversations response data for import candidates',
  );
  const initialConversation = snapshot?.conversations?.find(
    (conversation) => conversation.external_conversation_id === '8715744365612',
  );
  assert.ok(initialConversation, 'initial active conversation snapshot must be collected');
  const collected = initialConversation.snapshot_messages || [];
  assert.equal(
    collected.length,
    8,
    'conversation previews must be filtered while platform timeline nodes are retained',
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
      'middlePanel_List_lead',
      'middlePanel_List_notice',
      'middlePanel_List_message-c',
      'middlePanel_List_message-d',
      'middlePanel_List_product',
      'middlePanel_List_agent-product-reference',
    ],
  );
  assert.deepEqual(collected.map((item) => item.dom_sequence), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(collected[0].sender_role, 'agent');
  assert.equal(collected[0].content, 'First line\nSecond line', 'message line breaks must survive DOM collection');
  assert.equal(collected[1].sender_role, 'customer');
  assert.equal(collected[1].message_type, 'text', 'avatar must not turn text into an image message');
  assert.deepEqual(
    initialConversation.snapshot_messages.map((item) => item.platform_message_id),
    [
      'middlePanel_List_message-a',
      'middlePanel_List_message-b',
      'middlePanel_List_lead',
      'middlePanel_List_notice',
      'middlePanel_List_message-c',
      'middlePanel_List_message-d',
      'middlePanel_List_product',
      'middlePanel_List_agent-product-reference',
    ],
  );
  assert.deepEqual(
    initialConversation.snapshot_messages.map((item) => item.dom_sequence),
    [0, 1, 2, 3, 4, 5, 6, 7],
    'timeline sequence must remain continuous across platform nodes',
  );
  assert.equal(collected[2].message_type, 'context');
  assert.equal(collected[2].automation_mode, 'context');
  assert.equal(collected[2].sender_role, 'platform');
  assert.equal(collected[2].display_mode, 'card');
  assert.equal(collected[2].structured_payload.source_label, '当前用户来自 商品详情页');
  assert.equal(collected[2].structured_payload.title, '来源商品标题');
  assert.equal(collected[3].message_type, 'system');
  assert.equal(collected[3].automation_mode, 'ignore');
  assert.equal(collected[6].message_type, 'product', 'a customer product card must not degrade to an image');
  assert.equal(collected[6].sender_role, 'customer');
  assert.equal(collected[6].display_mode, 'card');
  assert.equal(collected[6].automation_mode, 'trigger', 'a customer product card must trigger a reply');
  assert.equal(collected[6].structured_payload.product_id, '970947366369');
  assert.equal(collected[6].structured_payload.title, '水杯古风床头新款小众彩绘三层正宗3d打印网红');
  assert.equal(collected[6].structured_payload.price, 10);
  assert.equal(collected[6].structured_payload.price_label, '￥10 /2人团');
  assert.equal(collected[6].time_label, '2026年08月14日 09:24:36');
  assert.equal(collected[7].sender_role, 'agent');
  assert.equal(
    collected[7].message_type,
    'text',
    'an ordinary agent reply that mentions a product ID must remain a text message',
  );
  assert.equal(collected[7].display_mode, 'bubble');
  assert.equal(
    initialConversation.customer_orders?.collection_status,
    'empty',
    'a stable personal-order panel showing 3年内无订单 must be treated as a normal empty state',
  );
  assert.equal(initialConversation.snapshot_messages[0].platform_sent_at, undefined);
  assert.equal(initialConversation.snapshot_messages[0].time_label, null);
  assert.equal(initialConversation.snapshot_messages[1].time_label, '2026年07月23日 16:17:38');
  assert.ok(snapshot.snapshot_id);
  const buyerB = unreadSnapshot?.conversations?.find(
    (conversation) => conversation.external_conversation_id === '9922334455667',
  );
  assert.ok(buyerB?.active, 'unread conversation must be verified as active before collection');
  assert.deepEqual(
    buyerB.snapshot_messages.map((message) => message.platform_message_id),
    ['middlePanel_List_b-message'],
  );
  assert.equal(buyerB.snapshot_messages[0].content, 'Message from Buyer B');
  assert.ok(
    !buyerB.snapshot_messages.some((message) => collected.some((initial) => initial.platform_message_id === message.platform_message_id)),
    'messages from the previous conversation must never be attached to the unread target',
  );
  const buyerC = secondUnreadSnapshot?.conversations?.find(
    (conversation) => conversation.external_conversation_id === '6677889900112',
  );
  assert.ok(buyerC?.active, 'the next unread conversation must be processed serially');
  assert.deepEqual(
    buyerC.snapshot_messages.map((message) => message.platform_message_id),
    ['middlePanel_List_c-message'],
  );
  assert.equal(buyerC.snapshot_messages[0].content, 'Message from Buyer C');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const initialSwitchCount = await window.webContents.executeJavaScript('document.body.dataset.switchCount');
  const initialSwitchLog = await window.webContents.executeJavaScript('document.body.dataset.switchLog');
  assert.equal(initialSwitchCount, '3', 'persistent unread previews must not be processed repeatedly');
  assert.equal(
    initialSwitchLog,
    'conversation-a,conversation-b,conversation-c',
    'the already-active unread conversation must still be clicked first',
  );

  const apiSwitchCountBefore = await window.webContents.executeJavaScript('document.body.dataset.switchCount');
  const apiRequestId = 'adapter-smoke-api-chat-list';
  window.webContents.send('pdd-adapter:command', {
    type: 'collect-conversation-api',
    requestId: apiRequestId,
    conversationKey: '9922334455667',
  });
  const apiDeadline = Date.now() + 5000;
  while (
    !messages.some((item) => item.type === 'api_chat_list_result' && item.request_id === apiRequestId)
    && Date.now() < apiDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const apiChatListResult = messages.find((item) => (
    item.type === 'api_chat_list_result' && item.request_id === apiRequestId
  ));
  assert.equal(apiChatListResult?.status, 'collected');
  assert.equal(apiChatListResult?.customer_uid, '9922334455667');
  assert.equal(apiChatListResult?.response?.result?.messages?.length, 2);
  assert.equal(chatListRequests.at(-1)?.body?.data?.list?.with?.id, '9922334455667');
  assert.equal(chatListRequests.at(-1)?.body?.data?.list?.start_index, 0);
  assert.equal(chatListRequests.at(-1)?.body?.client, 'WEB');
  assert.equal(chatListRequests.at(-1)?.headers?.['anti-content'], 'test-anti-content');
  assert.equal(chatListRequests.at(-1)?.body?.anti_content, 'test-body-anti-content');
  assert.equal(chatListRequests.at(-1)?.body?.data?.anti_content, 'test-body-anti-content');
  const apiSwitchCountAfter = await window.webContents.executeJavaScript('document.body.dataset.switchCount');
  assert.equal(
    apiSwitchCountAfter,
    apiSwitchCountBefore,
    'API chat/list collection must not click or switch the active DOM conversation',
  );
  const apiChatListShadow = messages.find((item) => (
    item.type === 'diagnostic'
    && item.stage === 'api_shadow_snapshot'
    && item.details?.endpoint === 'chat_list'
    && item.details?.customer_uids?.includes('9922334455667')
  ));
  assert.equal(apiChatListShadow?.details?.message_count, 2);
  await window.webContents.executeJavaScript(`
    (async () => {
      await fetch('/plateau/chat/pre_upload', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anti-content': 'test-anti-content'
        },
        body: JSON.stringify({
          request_id: 1787204151000,
          file_name: 'smoke.jpeg',
          file_type: 'image/jpeg'
        })
      });
      const uploadForm = new FormData();
      uploadForm.append('file', new Blob(['dynamic-upload-bytes'], { type: 'image/jpeg' }), 'dynamic.jpeg');
      uploadForm.append('upload_signature', 'smoke-upload-token');
      await fetch('/dynamic-image-upload', {
        method: 'POST',
        body: uploadForm
      });
      const form = new FormData();
      form.append('file', new Blob(['smoke-image-bytes'], { type: 'image/jpeg' }), 'smoke.jpeg');
      form.append('hash', 'smoke-image-hash');
      await fetch('/plateau/chat/store_image', {
        method: 'POST',
        headers: { 'anti-content': 'test-anti-content' },
        body: form
      });
    })();
  `);
  const imageUploadDeadline = Date.now() + 5000;
  while (
    !messages.some((item) => (
      item.type === 'diagnostic'
      && item.stage === 'api_shadow_snapshot'
      && item.details?.endpoint === 'image_store'
    ))
    && Date.now() < imageUploadDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const imagePreUploadShadow = messages.find((item) => (
    item.type === 'diagnostic'
    && item.stage === 'api_shadow_snapshot'
    && item.details?.endpoint === 'image_pre_upload'
  ));
  assert.equal(imagePreUploadShadow?.details?.request?.body_kind, 'json');
  assert.equal(imagePreUploadShadow?.details?.upload_token_present, true);
  const imageUploadShadow = messages.find((item) => (
    item.type === 'diagnostic'
    && item.stage === 'api_shadow_snapshot'
    && item.details?.endpoint === 'image_upload'
  ));
  assert.equal(imageUploadShadow?.details?.request?.body_kind, 'form_data');
  assert.deepEqual(imageUploadShadow?.details?.request?.field_names, ['file', 'upload_signature']);
  assert.equal(imageUploadShadow?.details?.http_status, 204);
  assert.equal(imageUploadShadow?.details?.request_url?.pathname, '/dynamic-image-upload');
  const imageStoreShadow = messages.find((item) => (
    item.type === 'diagnostic'
    && item.stage === 'api_shadow_snapshot'
    && item.details?.endpoint === 'image_store'
  ));
  assert.equal(imageStoreShadow?.details?.request?.body_kind, 'form_data');
  assert.deepEqual(imageStoreShadow?.details?.request?.field_names, ['file', 'hash']);
  assert.equal(imageStoreShadow?.details?.image_url, 'https://chat-img.pddugc.com/chat-pic-mall-cs-v1/2026-08-20/smoke.jpeg');
  assert.equal(imageStoreShadow?.details?.hash, 'smoke-image-hash');
  assert.equal(imageStoreShadow?.details?.width, 1170);
  assert.equal(imageStoreShadow?.details?.height, 1550);
  assert.equal(imageStoreShadow?.details?.image_size, 89);
  assert.equal(imageStoreShadow?.details?.thumb_data_present, true);
  const nativeSyncResult = messages.find((item) => (
    item.type === 'api_sync_message_result'
    && item.source === 'native'
    && item.response?.result?.sync_data?.some((syncItem) => (
      syncItem.data?.some((wrapper) => wrapper.message?.msg_id === 'sync-native-message')
    ))
  ));
  assert.equal(nativeSyncResult?.status, 'synced');
  const pollSyncDeadline = Date.now() + 5000;
  while (
    !messages.some((item) => (
      item.type === 'api_sync_message_result'
      && item.source === 'poll'
      && item.response?.result?.sync_data?.some((syncItem) => (
        syncItem.data?.some((wrapper) => wrapper.message?.msg_id === 'sync-poll-message')
      ))
    ))
    && Date.now() < pollSyncDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const pollSyncResult = messages.find((item) => (
    item.type === 'api_sync_message_result'
    && item.source === 'poll'
    && item.response?.result?.sync_data?.some((syncItem) => (
      syncItem.data?.some((wrapper) => wrapper.message?.msg_id === 'sync-poll-message')
    ))
  ));
  assert.equal(pollSyncResult?.status, 'synced', JSON.stringify({
    sync_request_count: syncMessageRequests.length,
    sync_request_seq_ids: syncMessageRequests.map((item) => item.body?.sync_key?.[0]?.seq_id),
    sync_result_sources: messages
      .filter((item) => item.type === 'api_sync_message_result')
      .map((item) => ({
        source: item.source,
        status: item.status,
        error: item.error,
        message_ids: item.response?.result?.sync_data?.flatMap((syncItem) => (
          syncItem.data?.map((wrapper) => wrapper.message?.msg_id) || []
        )),
      })),
    sync_diagnostics: messages
      .filter((item) => item.type === 'diagnostic' && String(item.stage || '').includes('api_sync'))
      .map((item) => ({ stage: item.stage, details: item.details })),
  }));
  assert.equal(syncMessageRequests[0]?.body?.sync_key?.[0]?.seq_id, 10);
  const firstPollSyncRequest = syncMessageRequests.find((item) => item.body?.sync_key?.[0]?.seq_id === 11);
  assert.equal(firstPollSyncRequest?.body?.sync_key?.[0]?.seq_id, 11);
  assert.equal(firstPollSyncRequest?.headers?.['anti-content'], 'test-anti-content');
  assert.equal(firstPollSyncRequest?.body?.anti_content, 'test-body-anti-content');

  const apiSendSwitchCountBefore = await window.webContents.executeJavaScript('document.body.dataset.switchCount');
  const apiSendRequestId = 'adapter-smoke-api-send-message';
  const apiSendContent = 'API send line 1\nline 2  with spaces';
  window.webContents.send('pdd-adapter:command', {
    type: 'send-message-api',
    requestId: apiSendRequestId,
    conversationKey: '9922334455667',
    customerName: 'Buyer B',
    content: apiSendContent,
  });
  const apiSendDeadline = Date.now() + 5000;
  while (
    !messages.some((item) => item.type === 'api_message_send_result' && item.request_id === apiSendRequestId)
    && Date.now() < apiSendDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const apiSendResult = messages.find((item) => (
    item.type === 'api_message_send_result' && item.request_id === apiSendRequestId
  ));
  assert.equal(apiSendResult?.status, 'sent');
  assert.equal(apiSendResult?.result?.msg_id, '1787031727088');
  assert.equal(sendMessageRequests.at(-1)?.headers?.['anti-content'], 'test-anti-content');
  assert.equal(sendMessageRequests.at(-1)?.body?.anti_content, 'test-body-anti-content');
  assert.equal(sendMessageRequests.at(-1)?.body?.data?.anti_content, 'test-body-anti-content');
  assert.equal(sendMessageRequests.at(-1)?.body?.data?.cmd, 'send_message');
  assert.equal(sendMessageRequests.at(-1)?.body?.data?.message?.to?.uid, '9922334455667');
  assert.equal(sendMessageRequests.at(-1)?.body?.data?.message?.content, apiSendContent);
  assert.equal(sendMessageRequests.at(-1)?.body?.data?.message?.type, 0);
  assert.equal(
    sendMessageRequests.at(-1)?.body?.data?.message?.hash,
    createHash('sha256').update(apiSendContent).digest('hex'),
  );
  const apiSendSwitchCountAfter = await window.webContents.executeJavaScript('document.body.dataset.switchCount');
  assert.equal(
    apiSendSwitchCountAfter,
    apiSendSwitchCountBefore,
    'API send_message must not click or switch the active DOM conversation',
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
  const apiShadow = messages.find((item) => (
    item.type === 'diagnostic'
    && item.stage === 'api_shadow_snapshot'
    && item.details?.endpoint === 'latest_conversations'
  ));
  assert.equal(apiShadow?.details?.shop_name, 'API Test store');
  assert.equal(apiShadow?.details?.conversation_count, 1);
  assert.equal(apiShadow?.details?.has_anti_content_header, true);
  assert.equal(apiShadow?.details?.has_anti_content_body, true);

  const sendRequestId = 'adapter-smoke-send-message';
  window.webContents.send('pdd-adapter:command', {
    type: 'send-message',
    requestId: sendRequestId,
    conversationKey: '9922334455667',
    customerName: 'Buyer B',
    content: 'Enter 发送验收消息',
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
  assert.equal(sendResult?.status, 'sent', 'message must be sent directly with Enter');
  assert.equal(sendResult?.method, 'enter');
  assert.equal(sendResult?.conversation_key, '9922334455667');
  const sentText = await window.webContents.executeJavaScript('document.querySelector("#replyTextarea").value');
  assert.equal(sentText, '');
  assert.equal(
    messages.some((item) => item.type === 'message_send_result' && item.status === 'failed'),
    false,
    'Enter send must not fail',
  );

  const enterRequestId = 'adapter-smoke-send-message-enter-repeat';
  window.webContents.send('pdd-adapter:command', {
    type: 'send-message',
    requestId: enterRequestId,
    conversationKey: '9922334455667',
    customerName: 'Buyer B',
    content: '再次 Enter 发送验收消息',
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
  assert.equal(enterResult?.status, 'sent', 'repeated Enter sending must succeed');
  assert.equal(enterResult?.method, 'enter');

  const imageRequestId = 'adapter-smoke-image-dom-confirmation';
  await window.webContents.executeJavaScript(`
    (() => {
      const dialog = document.createElement('div');
      dialog.id = 'slow-image-confirmation';
      dialog.setAttribute('role', 'dialog');
      dialog.textContent = '\u662f\u5426\u53d1\u9001\u56fe\u7247 \u53d1\u9001\u4e2d';
      Object.assign(dialog.style, { display: 'block', width: '200px', height: '100px' });
      document.body.appendChild(dialog);
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || document.querySelector('#middlePanel_List_slow-image')) return;
        setTimeout(() => {
          document.querySelector('#message-panel').insertAdjacentHTML(
            'beforeend',
            '<li id="middlePanel_List_slow-image" class="clearfix onemsg">'
              + '<div class="cs-item"><span class="msg-content">'
              + '<img src="https://img.example.com/slow-image.png">'
              + '</span></div></li>',
          );
        }, 300);
      });
    })();
  `);
  window.webContents.send('pdd-adapter:command', {
    type: 'send-image-enter',
    requestId: imageRequestId,
    expectedConversationKey: '9922334455667',
    customerName: 'Buyer B',
  });
  const imageDeadline = Date.now() + 10000;
  while (
    !messages.some((item) => item.type === 'image_send_result' && item.request_id === imageRequestId)
    && Date.now() < imageDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const imageResult = messages.find((item) => (
    item.type === 'image_send_result' && item.request_id === imageRequestId
  ));
  assert.equal(imageResult?.status, 'sent', 'DOM image echo must confirm a send while the modal remains visible');
  assert.equal(imageResult?.confirmation, 'dom_echo');
  await window.webContents.executeJavaScript("document.querySelector('#slow-image-confirmation')?.remove()");

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
      && conversation.snapshot_messages?.some((message) => message.platform_message_id === 'middlePanel_List_failure-a-message')
    ))
  ));
  assert.equal(incorrectlyBound, false, 'an unverified switch must never emit messages for the target');
  const currentConversationCollected = failedEvents.some((item) => (
    item.type === 'snapshot'
    && item.conversations?.some((conversation) => (
      conversation.customer_name === 'Failure Buyer A'
      && conversation.snapshot_messages?.some((message) => (
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
