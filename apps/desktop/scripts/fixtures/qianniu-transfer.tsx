import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatWindow from '../../src/message-center/components/ChatWindow';
import type { Conversation } from '../../src/shared/types';
import '../../src/index.css';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function Fixture() {
  const [scenario, setScenario] = useState('success');
  const [selected, setSelected] = useState('buyer-a');
  const [calls, setCalls] = useState(0);
  const [transfer, setTransfer] = useState<Conversation['qianniuTransfer']>(null);
  const conversation: Conversation = { id: selected, userName: selected, shopId: 'shop', shopName: '测试店铺:客服甲',
    platform: scenario === 'pdd' ? 'pinduoduo' : 'qianniu', platformName: '千牛', externalConversationId: '456.1-789.1#11001@cntaobao',
    lastMessage: '', status: 'active', awaitingReply: true, time: '12:00', messages: [], qianniuTransfer: transfer };
  return <div className="flex h-screen flex-col">
    <div className="flex flex-wrap gap-3 border-b p-2 text-xs">
      <span>模拟测试，不连接千牛</span>
      <select aria-label="测试场景" value={scenario} onChange={e => { setScenario(e.target.value); setTransfer(null); }}>
        {['success', 'empty', 'error', 'pending', 'slow', 'pdd'].map(x => <option key={x}>{x}</option>)}
      </select>
      <button onClick={() => { setSelected(x => x === 'buyer-a' ? 'buyer-b' : 'buyer-a'); setTransfer(null); }}>切换测试会话</button>
      <output>提交次数：{calls}</output>
    </div>
    <ChatWindow conversation={conversation} isLoading={false} error="" onSendMessage={async () => ({ draftOnly: false })}
      onSendImage={async () => {}} quickReplies={{ personal: [], team: [] }}
      onListTransferCs={async () => {
        await wait(scenario === 'slow' ? 3000 : 200);
        if (scenario === 'error') throw new Error('在线状态读取失败');
        return { status: 'collected', cs_list: scenario === 'empty' ? [] : [{ csid: 'target', accountName: '测试店铺:客服乙',
          nickname: '测试店铺:客服乙', remark: '', unreplyNum: 0, recvUser: null, bindWechat: false, onlineLabel: '电脑在线' }],
          trans_reason: [{ code: null, desc: '人工转接' }] };
      }} onTransferConversation={async () => {
        setCalls(x => x + 1); await wait(500);
        if (scenario === 'pending') { setTransfer({ status: 'confirmation_pending', targetNick: '客服乙' }); throw new Error('转接结果待确认，请勿重复提交'); }
        setTransfer({ status: 'transferred', targetNick: '客服乙' });
        return { status: 'transferred', target_cs_id: 'target', target_cs_username: '客服乙', target_cs_nickname: '客服乙' };
      }} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
