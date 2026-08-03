/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Platform,
  Message,
  Conversation,
  Shop,
  BotStatus,
  DesktopWindow,
  LogEntry,
} from '../shared/types';

export type { Platform, Message, Conversation, Shop, BotStatus, DesktopWindow, LogEntry };

export const MOCK_SHOPS: Shop[] = [
  { id: 'all', name: '全部门店' },
  { id: 's1', name: '旗舰店 A' },
  { id: 's2', name: '海外代购店 B' },
  { id: 's3', name: '社区团购店 C' },
];

export const MOCK_PLATFORMS: Platform[] = [
  { id: 'all', name: '全部', icon: 'LayoutGrid' },
  { id: 'qianniu', name: '千牛', icon: 'Store' },
  { id: 'douyin', name: '抖音', icon: 'Video' },
  { id: 'kuaishou', name: '快手', icon: 'Play' },
  { id: 'pinduoduo', name: '拼多多', icon: 'ShoppingBag' },
  { id: 'xiaohongshu', name: '小红书', icon: 'Heart' },
];

export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: '1',
    userName: '张伟',
    shopId: 's1',
    shopName: '旗舰店 A',
    lastMessage: '这个还有货吗？',
    platform: 'qianniu',
    platformName: '千牛',
    status: 'pending',
    time: '14:20',
    messages: [
      { id: 'm1', sender: 'user', content: '医生，这个还有货吗？', timestamp: '14:20' },
    ],
  },
  {
    id: '2',
    userName: '美美',
    shopId: 's2',
    shopName: '海外代购店 B',
    lastMessage: '视频里的同款链接在哪里？',
    platform: 'douyin',
    platformName: '抖音',
    status: 'pending',
    time: '12:05',
    messages: [
      { id: 'm4', sender: 'user', content: '视频里的同款链接在哪里？', timestamp: '12:05' },
    ],
  },
  {
    id: '3',
    userName: '小李',
    shopId: 's1',
    shopName: '旗舰店 A',
    lastMessage: '快递什么时候到？',
    platform: 'pinduoduo',
    platformName: '拼多多',
    status: 'active',
    time: '10:15',
    messages: [
      { id: 'm5', sender: 'user', content: '快递什么时候到？', timestamp: '10:15' },
    ],
  },
  {
    id: '4',
    userName: '阿强',
    shopId: 's3',
    shopName: '社区团购店 C',
    lastMessage: '真的好用吗？看很多人推荐',
    platform: 'xiaohongshu',
    platformName: '小红书',
    status: 'pending',
    time: '09:30',
    messages: [
      { id: 'm8', sender: 'user', content: '真的好用吗？看很多人推荐', timestamp: '09:30' },
    ],
  },
  {
    id: '5',
    userName: '老铁',
    shopId: 's2',
    shopName: '海外代购店 B',
    lastMessage: '谢谢老板',
    platform: 'kuaishou',
    platformName: '快手',
    status: 'resolved',
    time: '昨天',
    messages: [
      { id: 'm9', sender: 'user', content: '谢谢老板', timestamp: '昨天' },
    ],
  },
];

export const MOCK_DESKTOP_WINDOWS: DesktopWindow[] = [
  { id: 'w1', title: '千牛客服工作台 - 旗舰店 A', platform: 'qianniu', shopName: '旗舰店 A', associatedConversationId: '1' },
  { id: 'w2', title: '抖音小店商家后台 - 海外代购店 B', platform: 'douyin', shopName: '海外代购店 B', associatedConversationId: '2' },
  { id: 'w3', title: '拼多多商家管理后台 - 旗舰店 A', platform: 'pinduoduo', shopName: '旗舰店 A', associatedConversationId: '3' },
  { id: 'w4', title: '小红书专业号后台 - 社区团购店 C', platform: 'xiaohongshu', shopName: '社区团购店 C', associatedConversationId: '4' },
  { id: 'w5', title: '快手小店工作台 - 海外代购店 B', platform: 'kuaishou', shopName: '海外代购店 B', associatedConversationId: '5' },
];

export const MOCK_LOGS: LogEntry[] = [
  { id: 'l1', timestamp: '14:22:10', type: 'reply', message: '已自动回复张伟：是的，旗舰店 A 目前有现货。', details: 'Model: Gemini 1.5 Pro' },
  { id: 'l2', timestamp: '14:22:11', type: 'token', message: 'Token 调用', tokens: 154, details: 'Input: 45, Output: 109' },
  { id: 'l3', timestamp: '14:20:05', type: 'system', message: '上下文窗口已刷新', details: 'Session: conv_1' },
  { id: 'l4', timestamp: '14:15:30', type: 'reply', message: '已自动回复小李：快递预计于明天下午送达。' },
  { id: 'l5', timestamp: '14:15:31', type: 'token', message: 'Token 调用', tokens: 89, details: 'Input: 32, Output: 57' },
  { id: 'l6', timestamp: '14:10:12', type: 'system', message: '检测到模型延迟 1.4s', details: 'Region: asia-east1' },
];

export const MOCK_BOT: BotStatus = {
  name: 'OmniHelper v2',
  model: 'Gemini 1.5 Pro',
  status: 'online',
  uptime: '15d 4h 22m',
  requestsProcessed: 12450,
  avgResponseTime: '1.2s',
  health: 98,
};
