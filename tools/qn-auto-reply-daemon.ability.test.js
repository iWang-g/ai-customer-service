const assert = require('assert');
const http = require('http');

const {
  assertAbilityContext,
  invokeBridgeCommand,
  parseArgs,
  parseSendReceiptLine,
  selectAbilityClient,
} = require('./qn-auto-reply-daemon');

async function withMockBridge(run) {
  let resultPolls = 0;
  let receivedCommand = null;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/qn-bridge/command') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        receivedCommand = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, command: { id: 'test-command-1' } }));
      });
      return;
    }
    if (request.method === 'GET' && request.url.includes('/qn-bridge/results')) {
      resultPolls += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        result: resultPolls < 2
          ? null
          : {
              ok: true,
              cmd: 'openChat',
              state: {
                loginID: { targetId: 'shop-1', display: 'Shop A' },
                conversationID: { targetId: 'buyer-1', display: 'Buyer A', ccode: 'cid-1' },
              },
              value: {},
            },
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}/qn-bridge`, () => receivedCommand);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const defaults = parseArgs([]);
  assert.strictEqual(defaults.controlMode, 'Ability');
  assert.strictEqual(defaults.listen, false);
  assert.throws(() => parseArgs(['--control-mode', 'Unknown']), /Invalid --control-mode/);

  const now = new Date().toISOString();
  const selected = selectAbilityClient([
    {
      clientId: 'wrong-shop',
      waiting: true,
      abilityReady: true,
      lastSeen: now,
      state: { loginID: { targetId: 'shop-2', display: 'Shop B' } },
    },
    {
      clientId: 'target-shop',
      waiting: true,
      abilityReady: true,
      lastSeen: now,
      state: { loginID: { targetId: 'shop-1', display: 'Shop A' } },
    },
  ], 'shop-1', 'Shop A');
  assert.strictEqual(selected.clientId, 'target-shop');

  const task = {
    expectedLoginTargetId: 'shop-1',
    expectedLoginDisplay: 'Shop A',
    expectedTargetId: 'buyer-1',
    conversationName: 'Buyer A',
    expectedCid: 'cid-1',
  };
  const result = {
    state: {
      loginID: { targetId: 'shop-1', display: 'Shop A' },
      conversationID: { targetId: 'buyer-1', display: 'Buyer A', ccode: 'cid-1' },
    },
  };
  assert.doesNotThrow(() => assertAbilityContext(result, task, 'test'));
  assert.throws(
    () => assertAbilityContext({ ...result, state: { ...result.state, conversationID: { ...result.state.conversationID, ccode: 'wrong' } } }, task, 'test'),
    /context mismatch/,
  );

  const receiptLine = '[CHAT ][onMsgSendUpdate][ jsonStr=[{"cid":{"ccode":"cid-1"},"mcode":{"clientId":"local-1","messageId":"mid-1"},"originalData":{"text":"reply"},"progress":100,"sendStatus":0}] ]';
  assert.deepStrictEqual(parseSendReceiptLine(receiptLine, 'cid-1', 'reply'), {
    sendStatus: 0,
    progress: 100,
    clientId: 'local-1',
    messageId: 'mid-1',
    cid: 'cid-1',
    text: 'reply',
  });
  assert.strictEqual(parseSendReceiptLine(receiptLine, 'other-cid', 'reply'), null);

  await withMockBridge(async (bridgeBase, getReceivedCommand) => {
    const commandResult = await invokeBridgeCommand(
      bridgeBase,
      'target-shop',
      'openChat',
      { targetId: 'buyer-1', bizDomain: 'taobao' },
      3000,
    );
    assert.strictEqual(commandResult.ok, true);
    assert.deepStrictEqual(getReceivedCommand(), {
      clientId: 'target-shop',
      cmd: 'openChat',
      param: { targetId: 'buyer-1', bizDomain: 'taobao' },
    });
  });

  console.log('qn-auto-reply-daemon Ability tests passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
