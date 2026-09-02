import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mapChatListResponse,
  mapLatestConversationsResponse,
  mapPddRecommendGoodsResponse,
  mapPddUserAllOrderResponse,
  mapSendMessageResponse,
  mapSyncMessageResponse,
  summarizeMappedSnapshot,
} = require('../electron/platform-workspace/pinduoduo/api-mapper.cjs');

const latest = mapLatestConversationsResponse({
  success: true,
  result: {
    response: 'latest_conversations',
    result: 'ok',
    has_more: false,
    conversations: [{
      to: { role: 'user', uid: '9195398176930' },
      from: { role: 'mall_cs', uid: '688523141', mall_id: '688523141' },
      ts: '1786955732',
      content: '1',
      type: 0,
      status: 'unread',
      is_read: 1,
      msg_id: '1786955732373',
      mallName: '小王小店9527',
      pre_msg_id: '1786955420775',
      user_info: {
        uid: 9195398176930,
        avatar: 'https://savatar.pddpic.com/avatar',
        nickname: '加***鲨',
      },
      last_unreply_time: 0,
    }],
  },
}, '2026-08-18T00:00:00.000Z');

assert.equal(latest.platform_identity, null);
assert.equal(latest.conversations[0].external_conversation_id, '9195398176930');
assert.equal(latest.conversations[0].customer_name, '加***鲨');
assert.equal(latest.conversations[0].latest_message_text, '1');
assert.equal(latest.conversations[0].unread_count, 1);
assert.equal(latest.conversations[0].structured_payload.status, 'unread');
assert.equal(latest.conversations[0].structured_payload.is_read, 1);
assert.equal(latest.conversations[0].structured_payload.mall_name, '小王小店9527');

const chatList = mapChatListResponse({
  success: true,
  result: {
    response: 'list',
    result: 'ok',
    has_more: true,
    messages: [
      {
        from: { uid: '9195398176930', role: 'user' },
        to: { uid: '688523141', role: 'mall_cs' },
        type: 0,
        content: 'Order number:260805-038084298363116',
        info: {
          goodsID: 970947366369,
          goodsName: 'Water cup',
          goodsThumbUrl: 'https://img.pddpic.com/order.jpeg',
          orderSequenceNo: '260805-038084298363116',
          goodsNumber: 1,
          order_status: 2,
          pay_status: 0,
          shipping_status: 0,
          status: 7,
          group_status: 99,
          group_order_id: '3399617904927803116',
          order_id: '3399038084298363116',
          totalAmount: 1000,
          spec: 'Blue',
        },
        ts: '1786955800',
        msg_id: '1786955800000',
        pre_msg_id: '1786955732373',
        status: 'unread',
      },
      {
        to: { role: 'user', uid: '9195398176930' },
        from: { role: 'mall_cs', uid: '688523141', mall_id: '688523141' },
        ts: '1786955732',
        content: '好的亲亲',
        type: 0,
        msg_id: '1786955732373',
        pre_msg_id: '1786955420775',
        status: 'read',
        quote_msg: {
          from: { role: 'user', uid: '9195398176930' },
          to: { role: 'mall_cs', uid: '688523141' },
          type: 0,
          content: 'Is this available?',
          msg_id: '1786955420775',
        },
      },
      {
        from: { uid: '9195398176930', role: 'user' },
        to: { uid: '688523141', role: 'mall_cs' },
        type: 1,
        content: 'https://chat-img.pddugc.com/customer.jpeg',
        ts: '1786955420',
        msg_id: '1786955420775',
        pre_msg_id: '1786953946927',
        status: 'unread',
      },
      {
        from: { uid: '9195398176930', role: 'user' },
        to: { uid: '688523141', role: 'mall_cs' },
        type: 41,
        content: '[current user came from product detail page]',
        info: {
          title: 'Current user came from product detail page',
          goods_info: {
            goods_id: 970947366369,
            goods_name: 'Water cup',
            goods_thumb_url: 'https://img.pddpic.com/source.jpeg',
            total_amount: 1000,
            mall_link_url: 'https://mobile.yangkeduo.com/goods.html?goods_id=970947366369',
          },
        },
        ts: '1786953946',
        msg_id: '1786953946927',
        pre_msg_id: '1786953900000',
        template_name: 'user_source',
        status: 'unread',
      },
      {
        from: { uid: '9195398176930', role: 'user' },
        to: { uid: '688523141', role: 'mall_cs' },
        type: 0,
        content: 'goods.html?goods_id=970947366369',
        info: {
          goodsName: 'Water cup',
          goodsPrice: '10',
          goodsThumbUrl: 'https://img.pddpic.com/product.jpeg',
          salesTip: '3 people want this',
          linkUrl: 'goods.html?goods_id=970947366369',
          spellOrderData: {
            button: { text: 'Go group buy' },
          },
          goodsID: 970947366369,
        },
        biz_context: {
          minOnSaleGroupPrice: '1000',
          goodsId: '970947366369',
        },
        ts: '1786953900',
        msg_id: '1786953900000',
        pre_msg_id: '1786953800000',
        template_name: 'user_goods_card',
        status: 'unread',
      },
    ],
  },
}, { customerUid: '9195398176930', customerName: '加***鲨' });

assert.equal(chatList.conversations[0].snapshot_messages.length, 5);
assert.equal(chatList.conversations[0].snapshot_messages[0].sender_role, 'customer');
assert.equal(chatList.conversations[0].snapshot_messages[0].message_type, 'product');
assert.equal(chatList.conversations[0].snapshot_messages[0].display_mode, 'card');
assert.equal(chatList.conversations[0].snapshot_messages[0].automation_mode, 'trigger');
assert.equal(chatList.conversations[0].snapshot_messages[0].structured_payload.product_id, '970947366369');
assert.equal(chatList.conversations[0].snapshot_messages[0].structured_payload.price_label, '¥10.00');
assert.equal(
  chatList.conversations[0].snapshot_messages[0].structured_payload.link_url,
  'https://mobile.yangkeduo.com/goods.html?goods_id=970947366369',
);
assert.equal(chatList.conversations[0].snapshot_messages[1].message_type, 'context');
assert.equal(chatList.conversations[0].snapshot_messages[1].display_mode, 'card');
assert.equal(chatList.conversations[0].snapshot_messages[1].automation_mode, 'context');
assert.equal(
  chatList.conversations[0].snapshot_messages[1].structured_payload.source_label,
  'Current user came from product detail page',
);
assert.equal(chatList.conversations[0].snapshot_messages[1].structured_payload.price_label, '¥10.00');
assert.equal(chatList.conversations[0].snapshot_messages[2].message_type, 'image');
assert.equal(chatList.conversations[0].snapshot_messages[2].image_url, 'https://chat-img.pddugc.com/customer.jpeg');
assert.equal(chatList.conversations[0].snapshot_messages[3].sender_role, 'agent');
assert.equal(chatList.conversations[0].snapshot_messages[3].structured_payload.quote_msg_id, '1786955420775');
assert.equal(chatList.conversations[0].snapshot_messages[3].structured_payload.quote_msg.content, 'Is this available?');
assert.equal(chatList.conversations[0].snapshot_messages[4].message_type, 'order');
assert.equal(chatList.conversations[0].snapshot_messages[4].display_mode, 'card');
assert.equal(chatList.conversations[0].snapshot_messages[4].automation_mode, 'trigger');
assert.equal(chatList.conversations[0].snapshot_messages[4].structured_payload.order_sequence_no, '260805-038084298363116');
assert.equal(chatList.conversations[0].snapshot_messages[4].structured_payload.order_status_label, '已取消');
assert.equal(chatList.conversations[0].snapshot_messages[4].structured_payload.amount_label, '¥10.00');
assert.match(chatList.conversations[0].snapshot_messages[4].content, /Water cup/);
assert.equal(chatList.has_more, true);

const transferSystemMessage = mapChatListResponse({
  success: true,
  result: {
    response: 'list',
    result: 'ok',
    has_more: false,
    messages: [{
      from: { role: 'mall_cs', uid: '688523141', mall_id: '688523141', csid: '主账号' },
      to: { role: 'user', uid: '9195398176930' },
      type: 24,
      content: '主账号 将该会话转移给 王刚小店:泽锋，并留言：无原因直接转移',
      info: {
        origin_id: 187911167,
        target_id: 188413842,
      },
      ts: '1786955700',
      msg_id: '1786955700000',
    }],
  },
}, { customerUid: '9195398176930', customerName: 'Buyer' });
assert.equal(transferSystemMessage.conversations[0].snapshot_messages[0].sender_role, 'platform');
assert.equal(transferSystemMessage.conversations[0].snapshot_messages[0].message_type, 'system');
assert.equal(transferSystemMessage.conversations[0].snapshot_messages[0].display_mode, 'separator');
assert.equal(transferSystemMessage.conversations[0].snapshot_messages[0].automation_mode, 'ignore');
assert.equal(transferSystemMessage.conversations[0].snapshot_messages[0].structured_payload.raw_type, 24);
assert.equal(transferSystemMessage.conversations[0].snapshot_messages[0].structured_payload.from_csid, '主账号');

const customOrderPromptMessage = mapChatListResponse({
  success: true,
  result: {
    response: 'list',
    result: 'ok',
    has_more: false,
    messages: [{
      from: { role: 'mall_cs', uid: '688523141', mall_id: '688523141', csid: '主账号' },
      to: { role: 'user', uid: '1839008689561' },
      type: 0,
      content: '你刚刚拼单的商品为定制商品，需要确认定制方案哦~',
      ts: '1786955700',
      msg_id: '1786955700001',
    }],
  },
}, { customerUid: '1839008689561', customerName: 'Buyer' });
assert.equal(customOrderPromptMessage.conversations[0].snapshot_messages[0].sender_role, 'agent');
assert.equal(customOrderPromptMessage.conversations[0].snapshot_messages[0].automation_mode, 'context');
assert.equal(customOrderPromptMessage.conversations[0].snapshot_messages[0].structured_payload.from_csid, '主账号');
assert.equal(customOrderPromptMessage.conversations[0].snapshot_messages[0].structured_payload.to_uid, '1839008689561');

const additionalSystemMessages = mapChatListResponse({
  success: true,
  result: {
    response: 'list',
    result: 'ok',
    has_more: false,
    messages: [
      {
        from: { role: 'mall_cs', uid: '688523141', mall_id: '688523141' },
        to: { role: 'user', uid: '9195398176930' },
        type: 74,
        content: '已帮您免费开通官方客服机器人3天体验包',
        info: { content: [{ type: 'text', text: '已帮您免费开通官方客服机器人3天体验包' }] },
        ts: '1786955690',
        msg_id: '1786955690000',
      },
      {
        from: { role: 'user', uid: '9195398176930' },
        to: { role: 'mall_cs', uid: '688523141' },
        type: 31,
        content: '您接待过此消费者，为避免插嘴、抢答，机器人已暂停接待',
        info: { mall_content: '您接待过此消费者，为避免插嘴、抢答，机器人已暂停接待' },
        ts: '1786955680',
        msg_id: '1786955680000',
      },
      {
        from: { role: 'user', uid: '9195398176930' },
        to: { role: 'mall_cs', uid: '688523141' },
        type: 41,
        content: '[当前用户来自 商品详情页]',
        info: {
          title: '当前用户来自 商品详情页',
          goods_info: {
            goods_id: 970947366369,
            goods_name: 'Water cup',
            goods_thumb_url: 'https://img.pddpic.com/source.jpeg',
            total_amount: 450,
            mall_link_url: 'https://mobile.yangkeduo.com/goods.html?goods_id=970947366369',
          },
        },
        template_name: 'user_source',
        ts: '1786955670',
        msg_id: '1786955670000',
      },
    ],
  },
}, { customerUid: '9195398176930', customerName: 'Buyer' });
const additionalMessages = additionalSystemMessages.conversations[0].snapshot_messages;
assert.equal(additionalMessages[0].sender_role, 'platform');
assert.equal(additionalMessages[0].message_type, 'context');
assert.equal(additionalMessages[0].display_mode, 'card');
assert.equal(additionalMessages[0].automation_mode, 'context');
assert.equal(additionalMessages[0].structured_payload.source_label, '当前用户来自 商品详情页');
assert.equal(additionalMessages[1].sender_role, 'platform');
assert.equal(additionalMessages[1].message_type, 'system');
assert.equal(additionalMessages[1].display_mode, 'separator');
assert.equal(additionalMessages[1].automation_mode, 'ignore');
assert.equal(additionalMessages[2].sender_role, 'platform');
assert.equal(additionalMessages[2].message_type, 'system');
assert.equal(additionalMessages[2].display_mode, 'separator');
assert.equal(additionalMessages[2].automation_mode, 'ignore');

const agentProductList = mapChatListResponse({
  success: true,
  result: {
    response: 'list',
    result: 'ok',
    has_more: false,
    messages: [{
      to: { role: 'user', uid: '9195398176930' },
      from: { role: 'mall_cs', uid: '688523141', mall_id: '688523141' },
      type: 0,
      content: 'https://mobile.yangkeduo.com/goods.html?goods_id=970947366369',
      info: {
        goodsName: 'Water cup',
        goodsPrice: '10.0',
        defaultPriceStr: '10',
        goodsThumbUrl: 'https://img.pddpic.com/agent-product.jpeg',
        customerNumber: 2,
        salesTip: '',
        linkUrl: 'goods.html?goods_id=970947366369&_oak_rcto=agent',
        spellOrderData: {
          button: { text: 'View SKU' },
        },
        goodsID: 970947366369,
      },
      ts: '1786955600',
      msg_id: '1786955600000',
      pre_msg_id: '1786955420775',
      template_name: 'goods_info_card',
      status: 'read',
    }],
  },
}, { customerUid: '9195398176930', customerName: 'Buyer' });
assert.equal(agentProductList.conversations[0].snapshot_messages[0].sender_role, 'agent');
assert.equal(agentProductList.conversations[0].snapshot_messages[0].message_type, 'product');
assert.equal(agentProductList.conversations[0].snapshot_messages[0].display_mode, 'card');
assert.equal(agentProductList.conversations[0].snapshot_messages[0].automation_mode, 'context');
assert.equal(agentProductList.conversations[0].snapshot_messages[0].structured_payload.product_id, '970947366369');
assert.equal(agentProductList.conversations[0].snapshot_messages[0].structured_payload.title, 'Water cup');
assert.equal(agentProductList.conversations[0].snapshot_messages[0].structured_payload.price, 10);
assert.equal(agentProductList.conversations[0].snapshot_messages[0].structured_payload.image_url, 'https://img.pddpic.com/agent-product.jpeg');

const sync = mapSyncMessageResponse({
  success: true,
  result: {
    sync_data: [{
      seq_type: 1,
      seq_id: 572,
      has_gap: true,
      reset_seq_id: false,
      data: [{
        message: {
          from: { uid: '8715744365612', role: 'user' },
          to: { uid: '688523141', role: 'mall_cs' },
          content: '你好',
          type: 0,
          ts: '1787032427',
          msg_id: '1787032427965',
          pre_msg_id: '1787032112514',
        },
      }],
    }],
    server_time: 1787032428448,
  },
});

assert.equal(sync.sync_keys[0].seq_id, 572);
assert.equal(sync.conversations[0].external_conversation_id, '8715744365612');
assert.equal(sync.conversations[0].unread_count, 1);
assert.equal(sync.conversations[0].snapshot_messages[0].content, '你好');
assert.equal(sync.sync_gaps[0].has_gap, true);
assert.deepEqual(sync.sync_gaps[0].customer_uids, ['8715744365612']);

const sendResult = mapSendMessageResponse({
  success: true,
  result: {
    response: 'send_message',
    request_id: 1787032112238,
    result: 'ok',
    msg_id: 1787032112514,
    pre_msg_id: '1787031727088',
    ts: 1787032112,
  },
});
assert.equal(sendResult.success, true);
assert.equal(sendResult.msg_id, '1787032112514');

const orderSnapshot = mapPddUserAllOrderResponse({
  success: true,
  errorCode: 1000000,
  errorMsg: null,
  result: {
    pageNo: 1,
    pageSize: 10,
    total: 1,
    historyTotal: 0,
    orders: [{
      id: '3399038084298363116',
      uid: 8715744365612,
      groupOrderId: '3399617904927803116',
      orderSn: '260805-038084298363116',
      orderStatus: 2,
      payStatus: 0,
      shippingStatus: 0,
      groupStatus: 99,
      orderTime: 1785897992,
      payTime: 0,
      receiveTime: 0,
      orderAmount: 1000,
      discountAmount: 0,
      totalDiscount: 0,
      orderStatusStr: 'Cancelled',
      orderGoodsList: {
        goodsId: 970947366369,
        skuId: 1923440722486,
        goodsName: 'Water cup',
        goodsPrice: 1000,
        goodsNumber: 1,
        thumbUrl: 'https://img.pddpic.com/order.jpeg',
        spec: 'Blue',
      },
      compensate: {
        text: 'Shipping benefit',
      },
    }],
  },
}, { customerUid: '8715744365612', customerName: 'Buyer' }, '2026-08-18T01:00:00.000Z');
assert.equal(orderSnapshot.source, 'pdd_api_user_all_order');
assert.equal(orderSnapshot.conversations[0].external_conversation_id, '8715744365612');
assert.equal(orderSnapshot.conversations[0].customer_orders.collection_status, 'success');
assert.equal(orderSnapshot.conversations[0].customer_orders.orders.length, 1);
assert.equal(orderSnapshot.conversations[0].customer_orders.orders[0].platform_order_id, '260805-038084298363116');
assert.equal(orderSnapshot.conversations[0].customer_orders.orders[0].order_id, '3399038084298363116');
assert.equal(orderSnapshot.conversations[0].customer_orders.orders[0].group_order_id, '3399617904927803116');
assert.equal(orderSnapshot.conversations[0].customer_orders.orders[0].status, 'cancelled');
assert.equal(orderSnapshot.conversations[0].customer_orders.orders[0].order_amount, 10);
assert.equal(orderSnapshot.conversations[0].customer_orders.orders[0].paid_amount, 10);
assert.equal(orderSnapshot.conversations[0].customer_orders.orders[0].ordered_at, '2026-08-05T10:46:32');
assert.equal(orderSnapshot.conversations[0].customer_orders.orders[0].products[0].title, 'Water cup');
assert.equal(orderSnapshot.conversations[0].customer_orders.orders[0].products[0].image_url, 'https://img.pddpic.com/order.jpeg');
assert.equal(orderSnapshot.conversations[0].customer_orders.page_summary.total_count, 1);

const emptyOrderSnapshot = mapPddUserAllOrderResponse({
  success: true,
  errorCode: 1000000,
  result: {
    total: 0,
    historyTotal: 0,
    orders: null,
  },
}, { customerUid: '8799786063155', customerName: 'No orders' }, '2026-08-18T01:01:00.000Z');
assert.equal(emptyOrderSnapshot.conversations[0].customer_orders.collection_status, 'empty');
assert.equal(emptyOrderSnapshot.conversations[0].customer_orders.orders.length, 0);
assert.equal(emptyOrderSnapshot.conversations[0].customer_orders.page_summary.total_count, 0);

const productList = mapPddRecommendGoodsResponse({
  success: true,
  errorCode: 1000000,
  result: {
    recommendGoods: [{
      goodsId: 970947366369,
      goodsName: 'Water cup',
      thumbUrl: 'https://img.pddpic.com/product.jpeg',
      goodsUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=970947366369',
      quantity: 99,
      soldQuantity: 0,
      soldQuantity30d: 0,
      minOnSaleGroupPrice: 1000,
      defaultPriceStr: '10',
    }],
    onSaleGoods: [{
      goodsId: 970947366369,
      goodsName: 'Water cup duplicate',
    }],
    total: 1,
  },
}, '2026-08-18T01:02:00.000Z');
assert.equal(productList.success, true);
assert.equal(productList.collection_status, 'success');
assert.equal(productList.products.length, 1);
assert.equal(productList.products[0].product_id, '970947366369');
assert.equal(productList.products[0].title, 'Water cup');
assert.equal(productList.products[0].price, 10);
assert.equal(productList.products[0].quantity, 99);

const summary = summarizeMappedSnapshot(latest);
assert.deepEqual(summary.customer_uids, ['9195398176930']);
assert.equal(summary.shop_name, '小王小店9527');
assert.equal(summary.mall_id_present, true);

console.log('拼多多接口适配器测试通过');
