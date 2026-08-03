import { 
  LayoutDashboard, 
  Bot, 
  BookOpen, 
  Settings2, 
  Zap, 
  Settings,
  Headset,
  Code2,
  Mail,
} from 'lucide-react';

export const NAV_ITEMS = [
  { id: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
  { 
    id: 'agent', 
    label: 'Agent 设置', 
    icon: Bot,
    children: [
      { id: 'robot-list', label: '店铺机器人配置' },
    ]
  },
  { 
    id: 'knowledge', 
    label: '知识库', 
    icon: BookOpen,
    children: [
      { id: 'knowledge-qa', label: 'QA问答知识库' },
      { id: 'knowledge-product', label: '产品知识库' },
      { id: 'knowledge-tone', label: '语气知识库' },
    ]
  },
  { id: 'api', label: 'API 配置', icon: Code2 },
  { id: 'email', label: '邮件服务', icon: Mail },
  { id: 'settings', label: '通用设置', icon: Settings },
];

export const MOCK_AGENT_PLANS = [
  {
    id: '1',
    name: '官方旗舰店',
    scope: '1个店铺',
    triggers: 30,
    isEnabled: true,
    isDefault: false
  },
  {
    id: '2',
    name: '食品',
    scope: '1个店铺',
    triggers: 3,
    isEnabled: true,
    isDefault: false
  },
  {
    id: '3',
    name: '默认方案',
    scope: '全部店铺',
    triggers: 0,
    isEnabled: true,
    isDefault: true
  }
];

export const MOCK_ROBOTS = [
  {
    id: 'rob-001',
    name: '官方品牌导购机器人',
    model: 'Gemini 1.5 Pro',
    agentPlan: '官方旗舰店',
    knowledgeBases: ['产品知识库', 'QA问答知识库'],
    strategies: ['基础应答策略', '分流转接策略'],
    shops: ['官方旗舰店'],
    platformShops: ['拼多多 · 官方旗舰店'],
    status: '在线',
    lastUpdated: '2026-04-12'
  },
  {
    id: 'rob-002',
    name: '大促活动专服机器人',
    model: 'GPT-4o',
    agentPlan: '大促方案',
    knowledgeBases: ['产品知识库'],
    strategies: ['发送策略', '违禁词拦截'],
    shops: ['美妆生活馆', '数码精品店'],
    platformShops: ['拼多多 · 美妆生活馆', '拼多多 · 数码精品店'],
    status: '离线',
    lastUpdated: '2026-04-15'
  }
];

export const MOCK_STATS = [
  { 
    title: '今日消息数', 
    value: '12,840', 
    change: '+5.2%', 
    trend: 'up',
    description: '今日AI客服接收及发送的消息总数'
  },
  { 
    title: '有效恢复率', 
    value: '92.4%', 
    change: '+2.1%', 
    trend: 'up',
    description: '成功解决并关闭的会话占比'
  },
  { 
    title: '独立接待率', 
    value: '88.5%', 
    change: '+1.5%', 
    trend: 'up',
    description: '无需人工介入，由AI独立完成的接待占比'
  },
  { 
    title: '平均响应时间', 
    value: '1.2s', 
    change: '-0.3s', 
    trend: 'up', // for time, down is good, but let's just use 'up' arrow semantics for "improvement" or just handle color
    description: 'AI从接收消息到回复消息的平均耗时'
  },
  { 
    title: '订单转化率', 
    value: '15.2%', 
    change: '+0.8%', 
    trend: 'up',
    description: '通过AI引导最终生成并付款的订单比例'
  },
  { 
    title: '满意度', 
    value: '4.85', 
    change: '+0.12', 
    trend: 'up',
    description: '用户对AI回复质量的平均评分（总分5分）'
  },
  { 
    title: '转人工率', 
    value: '11.5%', 
    change: '-2.0%', 
    trend: 'up', // down is good
    description: '会话中途请求转人工处理的比例'
  },
  { 
    title: '撤回率', 
    value: '0.5%', 
    change: '-0.1%', 
    trend: 'up',
    description: '用户发送后又撤回的消息比例'
  },
];

export const CHART_DATA = [
  { name: '00:00', count: 40 },
  { name: '04:00', count: 20 },
  { name: '08:00', count: 180 },
  { name: '12:00', count: 250 },
  { name: '16:00', count: 320 },
  { name: '20:00', count: 210 },
  { name: '23:59', count: 90 },
];
