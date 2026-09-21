import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { configureDouyinSession, guardDouyinNavigation, isBrowserNavigation } from '../electron/platform-workspace/douyin/navigation-policy.js';

const contents = new EventEmitter();
guardDouyinNavigation(contents);
for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
  for (const url of ['bytedance://open', 'bitbrowser://open', 'file:///C:/Temp/empty_protocol.vbs', 'about:external']) {
    let prevented = false;
    const event = { preventDefault() { prevented = true; }, ...(name === 'will-frame-navigate' ? { url } : {}) };
    contents.emit(name, event, url);
    assert.equal(prevented, true, `${name} must block ${url}`);
  }
  for (const url of ['https://im.jinritemai.com/pc_seller_v2/main/workspace', 'about:blank', 'about:srcdoc']) {
    contents.emit(name, { url, preventDefault() { assert.fail(`blocked browser navigation: ${url}`); } }, url);
  }
}
assert.equal(isBrowserNavigation('not a URL'), false);
let check, request;
configureDouyinSession({
  setPermissionCheckHandler(handler) { check = handler; },
  setPermissionRequestHandler(handler) { request = handler; },
});
assert.equal(check(null, 'openExternal'), false);
request(null, 'openExternal', (allowed) => assert.equal(allowed, false));
console.log('Douyin navigation: main frame, subframe, redirect and external permission guards passed');
