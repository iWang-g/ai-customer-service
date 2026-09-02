const fs = require('fs');
const path = require('path');

const input = process.argv[2] || path.join('.tmp-qn-webui', 'web_chat-packer', 'recent', 'index.js');
const source = fs.readFileSync(input, 'utf8');

const keywords = [
  'SendMsg',
  'sendMessage',
  'DoSend',
  'SendChat',
  'ReSend',
  'onMsgSend',
  'onSendNewMsg',
  'sendByReceiverScope',
  'ConvertMsgText',
  'ConvertMsgText2Emotion',
  'ConvertMsgTextItems',
  'im.singlemsg.',
  'im.imbamsg.',
  'im.amptribemsg.',
  'im.tribemsg.',
];

function compact(value) {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 1200);
}

function printContext(keyword) {
  let from = 0;
  let count = 0;
  while (count < 15) {
    const index = source.indexOf(keyword, from);
    if (index < 0) break;
    const start = Math.max(0, index - 500);
    const end = Math.min(source.length, index + keyword.length + 700);
    console.log(`\n=== ${keyword} @ ${index} ===`);
    console.log(compact(source.slice(start, end)));
    from = index + keyword.length;
    count += 1;
  }
}

for (const keyword of keywords) printContext(keyword);

const methodPattern = /im\.(?:singlemsg|imbamsg|amptribemsg|tribemsg|bizutil|uiutil)\.[A-Za-z0-9_]+/g;
const methods = new Map();
let match;
while ((match = methodPattern.exec(source))) {
  const method = match[0];
  methods.set(method, (methods.get(method) || 0) + 1);
}

console.log('\n=== bridge methods containing send/msg/convert ===');
for (const [method, count] of [...methods.entries()].sort()) {
  if (/send|msg|convert|message/i.test(method)) console.log(`${count}\t${method}`);
}
