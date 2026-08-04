/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronRight, 
  ChevronLeft,
  ArrowLeft,
  Search, 
  Bell, 
  User,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  Clock,
  ThumbsUp,
  ShoppingBag,
  ExternalLink,
  Info,
  Bot,
  LayoutDashboard,
  Settings,
  Zap,
  MessageSquare,
  Calendar,
  Activity,
  DollarSign,
  Users,
  ChevronDown,
  ChevronUp,
  Plus,
  GripVertical,
  Pencil,
  Trash2,
  Headset,
  Code2,
  Key,
  Copy,
  RefreshCw,
  GitMerge,
  ShieldAlert,
  LifeBuoy,
  X,
  Image as ImageIcon,
  FileText,
  UploadCloud,
  CheckCircle2
} from 'lucide-react';
import ImagePreview from '../../shared/components/ImagePreview';
import { getDashboardAnalytics } from '../../shared/api/client';
import type { DashboardAnalytics, TestReplyResult } from '../../shared/api/client';
import type { EmailTemplateInput } from '../../shared/api/client';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { NAV_ITEMS, MOCK_AGENT_PLANS } from '../constants';
import type { AdminController } from '../state/useAdminController';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function shanghaiDate(date = new Date()): string {
  return SHANGHAI_DATE_FORMATTER.format(date);
}

function shiftDate(dateValue: string, days: number): string {
  const date = new Date(`${dateValue}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return shanghaiDate(date);
}

function formatResponseTime(seconds: number | null): string {
  if (seconds === null) return '--';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(minutes < 10 ? 1 : 0)} 分钟`;
}

interface AdminWorkspaceProps {
  onBack: () => void;
  controller: AdminController;
}

type OutboundBlockRule = {
  word: string;
  replacement: string;
  enabled: boolean;
};

export default function AdminWorkspace({ onBack, controller }: AdminWorkspaceProps) {
  const {
    activeTab,
    setActiveTab,
    selectedPlanId,
    setSelectedPlanId,
    robots,
    platformAccounts,
    robotKnowledgeBases,
    selectedRobot,
    isLoadingRobots,
    isSavingRobot,
    robotNotice,
    selectedQABase,
    setSelectedQABase,
    isAddQABaseModalOpen,
    setIsAddQABaseModalOpen,
    newQABaseForm,
    setNewQABaseForm,
    isAddQAItemModalOpen,
    setIsAddQAItemModalOpen,
    editingQAItemId,
    setEditingQAItemId,
    qaItemForm,
    setQaItemForm,
    qaBases,
    setQaBases,
    qaItems,
    qaCategories,
    qaCategoryFilter,
    changeQaCategoryFilter,
    qaKeywordDraft,
    setQaKeywordDraft,
    submitQaSearch,
    qaPage,
    setQaPage,
    qaPageCount,
    qaTotal,
    newQaCategoryName,
    setNewQaCategoryName,
    isCreatingQaCategory,
    handleCreateQaCategory,
    toggleQAItem,
    isLoadingQA,
    isSavingQA,
    qaNotice,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    expandedMenus,
    setExpandedMenus,
    robotSubTab,
    setRobotSubTab,
    routingCards,
    setRoutingCards,
    productBases,
    isAddProductKBModalOpen,
    setIsAddProductKBModalOpen,
    newProductKBForm,
    setNewProductKBForm,
    isLoadingProductKB,
    isSavingProductKB,
    productKBNotice,
    selectedProductKB,
    productKBName,
    setProductKBName,
    productDocuments,
    selectedProductDocument,
    productDocumentDetail,
    productDocumentChunks,
    selectedProductFile,
    isImportingProductDocument,
    productImportProgress,
    productImportNotice,
    isLoadingProductDocuments,
    isLoadingProductDocumentDetail,
    productDocumentDetailNotice,
    toneBases,
    isLoadingToneKB,
    isSavingToneKB,
    toneKBNotice,
    isAddToneKBModalOpen,
    setIsAddToneKBModalOpen,
    editingToneKBId,
    setEditingToneKBId,
    newToneKBForm,
    setNewToneKBForm,
    handleAddRoutingCard,
    handleDeleteRoutingCard,
    handleUpdateRoutingRatio,
    handleAddQABase,
    handleAddQAItem,
    openAddQAItem,
    openEditQAItem,
    handleDeleteQAItem,
    handleDeleteQABase,
    handleAddProductKB,
    handleDeleteProductKB,
    openProductKBConfig,
    closeProductKBConfig,
    handleUpdateProductKB,
    selectProductFile,
    handleImportProductDocument,
    handleDeleteProductDocument,
    refreshProductDocuments,
    openProductDocumentDetail,
    closeProductDocumentDetail,
    openAddToneKB,
    openEditToneKB,
    handleSaveToneKB,
    handleDeleteToneKB,
    toggleMenu,
    handleEditPlan,
    openRobotConfig,
    saveRobot,
    toggleRobotStatus,
    handleDeleteRobot,
    aiConfig,
    aiConfigMaskedKey,
    isLoadingAiConfig,
    isSavingAiConfig,
    isTestingAiConfig,
    aiConfigNotice,
    updateAiConfig,
    handleSaveAiConfig,
    handleTestAiConfig,
    emailConfig,
    emailAuthCodeSaved,
    emailTemplates,
    isLoadingEmail,
    isSavingEmail,
    isTestingEmail,
    emailNotice,
    updateEmailConfig,
    handleSaveEmailConfig,
    handleTestEmailConfig,
    handleSaveEmailTemplate,
    handleDeleteEmailTemplate,
    runTestRobotReply,
    userSettings,
    isLoadingSettings,
    isSavingSettings,
    settingsNotice,
    updateUserSettings,
    handleSaveUserSettings,
  } = controller;

  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const today = shanghaiDate();
  const [dashboardStartDate, setDashboardStartDate] = useState(today);
  const [dashboardEndDate, setDashboardEndDate] = useState(today);
  const [dashboardData, setDashboardData] = useState<DashboardAnalytics | null>(null);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);
  const [dashboardNotice, setDashboardNotice] = useState('');
  const [isFullReportModalOpen, setIsFullReportModalOpen] = useState(false);
  const [testReplyRobotId, setTestReplyRobotId] = useState<string | null>(null);
  const [testReplyText, setTestReplyText] = useState('');
  const [testReplyResult, setTestReplyResult] = useState('');
  const [testReplyDebug, setTestReplyDebug] = useState<TestReplyResult | null>(null);
  const [testReplyMessages, setTestReplyMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string; media?: Array<{ type: string; url?: string }> }>>([]);
  const [isTestingReply, setIsTestingReply] = useState(false);
  const [showQaCategoryCreator, setShowQaCategoryCreator] = useState(false);
  const [productDocumentTab, setProductDocumentTab] = useState<'chunks' | 'content'>('chunks');
  const [productDocumentSearch, setProductDocumentSearch] = useState('');
  const normalizedProductDocumentSearch = productDocumentSearch.trim().toLocaleLowerCase();
  const visibleProductDocumentChunks = normalizedProductDocumentSearch
    ? productDocumentChunks.filter((chunk) => `${chunk.title_path}\n${chunk.content}`.toLocaleLowerCase().includes(normalizedProductDocumentSearch))
    : productDocumentChunks;
  const closeProductDocumentModal = () => {
    closeProductDocumentDetail();
    setProductDocumentTab('chunks');
    setProductDocumentSearch('');
  };
  const [emailTestRecipient, setEmailTestRecipient] = useState('');
  const [emailTestTemplateId, setEmailTestTemplateId] = useState('');
  const [emailTemplateModalId, setEmailTemplateModalId] = useState<string | null | undefined>(undefined);
  const emptyEmailTemplate: EmailTemplateInput = {
    template_key: '', name: '', scene: 'store_view_link', aliases: [], subject: '', body: '', enabled: true,
  };
  const [emailTemplateForm, setEmailTemplateForm] = useState<EmailTemplateInput>(emptyEmailTemplate);
  const [robotName, setRobotName] = useState('');
  const [robotModel, setRobotModel] = useState('deepseek-chat');
  const [robotTemperature, setRobotTemperature] = useState(0.2);
  const [allowRobotAutoReply, setAllowRobotAutoReply] = useState(false);
  const [selectedQaKBIds, setSelectedQaKBIds] = useState<string[]>([]);
  const [selectedProductKBIds, setSelectedProductKBIds] = useState<string[]>([]);
  const [baseStyle, setBaseStyle] = useState('专业');
  const [answerLength, setAnswerLength] = useState('适中');
  const [contextLength, setContextLength] = useState(20);
  const [customerAddress, setCustomerAddress] = useState('亲亲');
  const [selfAddress, setSelfAddress] = useState('在下');
  const [isCustomCustomerAddress, setIsCustomCustomerAddress] = useState(false);
  const [isCustomSelfAddress, setIsCustomSelfAddress] = useState(false);
  const [advancedInstruction, setAdvancedInstruction] = useState('善用 emoji 表情符号和分点，直观呈现重点信息，提升亲和力。');
  const [inboundSensitiveWords, setInboundSensitiveWords] = useState<string[]>([]);
  const [sensitiveWordDraft, setSensitiveWordDraft] = useState('');
  const [outboundBlockRules, setOutboundBlockRules] = useState<OutboundBlockRule[]>([]);
  const [outboundBlockWordDraft, setOutboundBlockWordDraft] = useState('');
  const [outboundReplacementDraft, setOutboundReplacementDraft] = useState('');
  const [fallbackReplyText, setFallbackReplyText] = useState('您的问题我将为您接入专业产品客服，请稍后');
  const [fallbackMarkHumanRequired, setFallbackMarkHumanRequired] = useState(false);
  const [timeoutEnabled, setTimeoutEnabled] = useState(true);
  const [timeoutSeconds, setTimeoutSeconds] = useState(10);
  const [timeoutReplyText, setTimeoutReplyText] = useState('专项客服正在赶来的路上请稍等~~');
  const [selectedToneKB, setSelectedToneKB] = useState('');
  const platformOptions = ['全部平台', '千牛', '拼多多', '个人微信', 'QQ', '抖音', '快手', '小红书'];
  const platformCodeByLabel: Record<string, string> = {
    全部平台: 'all', 千牛: 'qianniu', 拼多多: 'pinduoduo', 个人微信: 'wechat',
    QQ: 'qq', 抖音: 'douyin', 快手: 'kuaishou', 小红书: 'xiaohongshu',
  };
  const platformLabelByCode = Object.fromEntries(
    Object.entries(platformCodeByLabel).map(([label, code]) => [code, label]),
  ) as Record<string, string>;
  const pddAccountNames = platformAccounts
    .filter((account) => account.platform_code === 'pinduoduo' && account.is_active)
    .map((account) => account.account_alias || account.account_name);
  const platformShopOptions: Record<string, string[]> = {
    千牛: ['全部店铺'],
    拼多多: [...pddAccountNames, '全部店铺'],
    个人微信: ['全部店铺'],
    QQ: ['QQ客服号', '全部店铺'],
    抖音: ['全部店铺'],
    快手: ['全部店铺'],
    小红书: ['全部店铺'],
  };
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [selectedShops, setSelectedShops] = useState<Record<string, string[]>>({});

  const loadDashboard = async (startDate = dashboardStartDate, endDate = dashboardEndDate) => {
    if (!startDate || !endDate) {
      setDashboardNotice('请选择完整的开始日期和结束日期');
      return;
    }
    if (endDate < startDate) {
      setDashboardNotice('结束日期不能早于开始日期');
      return;
    }
    const rangeDays = Math.round(
      (new Date(`${endDate}T12:00:00+08:00`).getTime() - new Date(`${startDate}T12:00:00+08:00`).getTime())
      / 86_400_000,
    ) + 1;
    if (rangeDays > 90) {
      setDashboardNotice('查询日期范围不能超过 90 天');
      return;
    }
    setIsLoadingDashboard(true);
    setDashboardNotice('');
    try {
      setDashboardData(await getDashboardAnalytics(startDate, endDate));
    } catch (error) {
      setDashboardNotice(error instanceof Error ? error.message : '数据概览加载失败');
    } finally {
      setIsLoadingDashboard(false);
    }
  };

  const setDashboardRange = (startDate: string, endDate: string) => {
    setDashboardStartDate(startDate);
    setDashboardEndDate(endDate);
    void loadDashboard(startDate, endDate);
  };

  useEffect(() => {
    if (activeTab === 'dashboard' && dashboardData === null && !isLoadingDashboard) {
      void loadDashboard(today, today);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!selectedRobot) {
      setRobotName('');
      setRobotModel('deepseek-chat');
      setRobotTemperature(0.2);
      setAllowRobotAutoReply(false);
      setBaseStyle('专业');
      setAnswerLength('适中');
      setContextLength(20);
      setCustomerAddress('亲亲');
      setSelfAddress('在下');
      setIsCustomCustomerAddress(false);
      setIsCustomSelfAddress(false);
      setAdvancedInstruction('善用 emoji 表情符号和分点，直观呈现重点信息，提升亲和力。');
      setInboundSensitiveWords([]);
      setSensitiveWordDraft('');
      setOutboundBlockRules([]);
      setOutboundBlockWordDraft('');
      setOutboundReplacementDraft('');
      setFallbackReplyText('您的问题我将为您接入专业产品客服，请稍后');
      setFallbackMarkHumanRequired(false);
      setTimeoutEnabled(true);
      setTimeoutSeconds(10);
      setTimeoutReplyText('专项客服正在赶来的路上请稍等~~');
      setSelectedQaKBIds([]);
      setSelectedProductKBIds([]);
      setSelectedToneKB('');
      setSelectedPlatforms([]);
      setSelectedShops({});
      return;
    }
    const config = selectedRobot.api.config_json;
    setRobotName(selectedRobot.name);
    setRobotModel(typeof config.model === 'string' ? config.model : 'deepseek-chat');
    setRobotTemperature(typeof config.temperature === 'number' ? config.temperature : 0.2);
    setAllowRobotAutoReply(config.allow_auto_send === true);
    setBaseStyle(typeof config.base_style === 'string' ? config.base_style : '专业');
    setAnswerLength(typeof config.answer_length === 'string' ? config.answer_length : '适中');
    setContextLength(typeof config.context_length === 'number' ? Math.max(1, Math.min(50, Math.round(config.context_length))) : 20);
    const configuredCustomerAddress = typeof config.customer_address === 'string' ? config.customer_address : '亲亲';
    const configuredSelfAddress = typeof config.self_address === 'string' ? config.self_address : '在下';
    const savedCustomerAddress = configuredCustomerAddress === '自定义' ? '' : configuredCustomerAddress;
    const savedSelfAddress = configuredSelfAddress === '自定义' ? '' : configuredSelfAddress;
    setCustomerAddress(savedCustomerAddress);
    setSelfAddress(savedSelfAddress);
    setIsCustomCustomerAddress(configuredCustomerAddress === '自定义' || !['亲亲', '宝宝'].includes(savedCustomerAddress));
    setIsCustomSelfAddress(configuredSelfAddress === '自定义' || !['在下', '鄙人'].includes(savedSelfAddress));
    setAdvancedInstruction(typeof config.advanced_instruction === 'string' ? config.advanced_instruction : '');
    setInboundSensitiveWords(Array.isArray(config.inbound_sensitive_words)
      ? config.inbound_sensitive_words.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : []);
    setSensitiveWordDraft('');
    const configuredBlockRules: OutboundBlockRule[] = Array.isArray(config.outbound_block_rules)
      ? config.outbound_block_rules.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const rule = item as Record<string, unknown>;
        const word = typeof rule.word === 'string' ? rule.word.trim() : '';
        const replacement = typeof rule.replacement === 'string' ? rule.replacement.trim() : '';
        return word ? [{ word, replacement, enabled: rule.enabled !== false }] : [];
      })
      : [];
    const configuredRuleWords = new Set(configuredBlockRules.map((rule) => rule.word.toLocaleLowerCase()));
    const legacyBlockRules: OutboundBlockRule[] = Array.isArray(config.outbound_block_words)
      ? config.outbound_block_words.flatMap((item) => {
        const word = typeof item === 'string' ? item.trim() : '';
        return word && !configuredRuleWords.has(word.toLocaleLowerCase())
          ? [{ word, replacement: '', enabled: true }]
          : [];
      })
      : [];
    setOutboundBlockRules([...configuredBlockRules, ...legacyBlockRules]);
    setOutboundBlockWordDraft('');
    setOutboundReplacementDraft('');
    setFallbackReplyText(typeof config.fallback_reply_text === 'string' && config.fallback_reply_text.trim()
      ? config.fallback_reply_text
      : '您的问题我将为您接入专业产品客服，请稍后');
    setFallbackMarkHumanRequired(
      typeof config.fallback_mark_human_required === 'boolean'
        ? config.fallback_mark_human_required
        : config.fallback_transfer_to_human === true,
    );
    setTimeoutEnabled(config.timeout_enabled !== false);
    setTimeoutSeconds(typeof config.timeout_seconds === 'number' ? Math.max(1, Math.min(60, Math.round(config.timeout_seconds))) : 10);
    setTimeoutReplyText(typeof config.timeout_reply_text === 'string' && config.timeout_reply_text.trim()
      ? config.timeout_reply_text
      : '专项客服正在赶来的路上请稍等~~');
    setSelectedQaKBIds(selectedRobot.api.qa_knowledge_base_ids);
    setSelectedProductKBIds(selectedRobot.api.product_knowledge_base_ids);
    setSelectedToneKB(selectedRobot.api.tone_knowledge_base_id || '');
    const platforms: string[] = [];
    const shops: Record<string, string[]> = {};
    selectedRobot.api.platform_scopes.forEach((scope) => {
      const label = platformLabelByCode[scope.platform_code] || scope.platform_code;
      if (!platforms.includes(label)) platforms.push(label);
      if (scope.all_accounts) {
        shops[label] = ['全部店铺'];
        return;
      }
      const account = platformAccounts.find((item) => item.id === scope.platform_account_id);
      if (account) shops[label] = [...(shops[label] || []), account.account_alias || account.account_name];
    });
    setSelectedPlatforms(platforms);
    setSelectedShops(shops);
  }, [selectedRobot?.id, selectedRobot?.api.updated_at, platformAccounts]);

  const togglePlatform = (platform: string) => {
    if (platform === '全部平台') {
      setSelectedPlatforms((prev) => prev.includes('全部平台') ? [] : ['全部平台']);
      return;
    }
    setSelectedPlatforms((prev) => {
      const withoutAll = prev.filter((item) => item !== '全部平台');
      return withoutAll.includes(platform) ? withoutAll.filter((item) => item !== platform) : [...withoutAll, platform];
    });
  };

  const toggleShop = (platform: string, shop: string) => {
    setSelectedShops((prev) => {
      const current = prev[platform] ?? [];
      if (shop === '全部店铺') return { ...prev, [platform]: current.includes(shop) ? [] : ['全部店铺'] };
      const withoutAll = current.filter((item) => item !== '全部店铺');
      const next = withoutAll.includes(shop) ? withoutAll.filter((item) => item !== shop) : [...withoutAll, shop];
      return { ...prev, [platform]: next };
    });
  };

  const toggleKnowledgeBase = (
    setter: React.Dispatch<React.SetStateAction<string[]>>,
    id: string,
  ) => setter((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const handleSaveRobotConfiguration = async () => {
    if (!robotName.trim()) return;
    const existingRobotConfig = { ...(selectedRobot?.api.config_json || {}) };
    delete existingRobotConfig.fallback_transfer_to_human;
    const platformScopes: Array<{ platform_code: string; platform_account_id: string | null; all_accounts: boolean }> = [];
    selectedPlatforms.forEach((label) => {
      const platformCode = platformCodeByLabel[label] || label;
      if (label === '全部平台') {
        platformScopes.push({ platform_code: platformCode, platform_account_id: null, all_accounts: true });
        return;
      }
      const shops = selectedShops[label] || [];
      if (shops.length === 0 || shops.includes('全部店铺')) {
        platformScopes.push({ platform_code: platformCode, platform_account_id: null, all_accounts: true });
        return;
      }
      shops.forEach((shopName) => {
        const account = platformAccounts.find((item) =>
          item.platform_code === platformCode && (item.account_alias === shopName || item.account_name === shopName));
        if (account) platformScopes.push({ platform_code: platformCode, platform_account_id: account.id, all_accounts: false });
      });
    });
    await saveRobot({
      name: robotName.trim(),
      enabled: selectedRobot?.api.enabled ?? false,
        config_json: {
        ...existingRobotConfig,
        model: robotModel,
        temperature: robotTemperature,
        allow_auto_send: allowRobotAutoReply,
        base_style: baseStyle,
        answer_length: answerLength,
        context_length: contextLength,
        customer_address: customerAddress,
        self_address: selfAddress,
        advanced_instruction: advancedInstruction.trim(),
        inbound_sensitive_words: inboundSensitiveWords,
        sensitive_word_action: 'mark_human',
        outbound_block_rules: outboundBlockRules
          .filter((rule) => rule.word.trim() && rule.replacement.trim())
          .map((rule) => ({ word: rule.word.trim(), replacement: rule.replacement.trim(), enabled: rule.enabled })),
        outbound_block_words: outboundBlockRules
          .filter((rule) => rule.enabled && rule.word.trim() && !rule.replacement.trim())
          .map((rule) => rule.word.trim()),
        outbound_block_action: outboundBlockRules.some((rule) => rule.enabled && rule.word.trim() && rule.replacement.trim()) ? 'replace' : 'fallback',
        fallback_reply_text: fallbackReplyText.trim(),
        fallback_mark_human_required: fallbackMarkHumanRequired,
        timeout_enabled: timeoutEnabled,
        timeout_seconds: timeoutSeconds,
        timeout_reply_text: timeoutReplyText.trim(),
        routing_cards: routingCards,
      },
      qa_knowledge_base_ids: selectedQaKBIds,
      product_knowledge_base_ids: selectedProductKBIds,
      tone_knowledge_base_id: selectedToneKB || null,
      platform_scopes: platformScopes,
    });
    setActiveTab('robot-list');
  };
  const addSensitiveWord = () => {
    const word = sensitiveWordDraft.trim();
    if (!word || inboundSensitiveWords.some((item) => item.toLocaleLowerCase() === word.toLocaleLowerCase())) return;
    setInboundSensitiveWords((current) => [...current, word]);
    setSensitiveWordDraft('');
  };
  const addOutboundBlockWord = () => {
    const word = outboundBlockWordDraft.trim();
    const replacement = outboundReplacementDraft.trim();
    if (!word || !replacement || outboundBlockRules.length >= 200 || outboundBlockRules.some((item) => item.word.toLocaleLowerCase() === word.toLocaleLowerCase())) return;
    setOutboundBlockRules((current) => [...current, { word, replacement, enabled: true }]);
    setOutboundBlockWordDraft('');
    setOutboundReplacementDraft('');
  };
  const handleTestReply = async () => {
    const message = testReplyText.trim();
    if (!message || !testReplyRobotId || isTestingReply) return;
    setIsTestingReply(true);
    setTestReplyResult('');
    const history = testReplyMessages.map((item) => ({ role: item.role, content: item.content }));
    setTestReplyMessages((prev) => [...prev, { role: 'user', content: message }]);
    setTestReplyText('');
    try {
      const result = await runTestRobotReply({ robot_id: testReplyRobotId, message, conversation: history, platform_code: 'pinduoduo', customer_name: '测试客户' });
      setTestReplyMessages((prev) => [...prev, { role: 'assistant', content: result.text || '机器人未生成文本回复。', media: result.media }]);
      setTestReplyDebug(result);
    } catch (error) {
      setTestReplyResult(error instanceof Error ? error.message : '测试回复失败');
    } finally {
      setIsTestingReply(false);
    }
  };
  const requestConfirm = (message: string, onConfirm: () => void) => setConfirmDialog({ message, onConfirm });
  const applyEmailProviderDefaults = (provider: 'qq' | 'gmail' | 'custom') => {
    const defaults = provider === 'qq'
      ? { smtp_host: 'smtp.qq.com', smtp_port: 465, security: 'ssl' as const }
      : provider === 'gmail'
        ? { smtp_host: 'smtp.gmail.com', smtp_port: 587, security: 'starttls' as const }
        : { smtp_host: '', smtp_port: 465, security: 'ssl' as const };
    updateEmailConfig('provider', provider);
    updateEmailConfig('smtp_host', defaults.smtp_host);
    updateEmailConfig('smtp_port', defaults.smtp_port);
    updateEmailConfig('security', defaults.security);
  };
  const openEmailTemplateModal = (id: string | null) => {
    const template = id ? emailTemplates.find((item) => item.id === id) : null;
    setEmailTemplateForm(template ? {
      template_key: template.template_key,
      name: template.name,
      scene: template.scene,
      aliases: template.aliases,
      subject: template.subject,
      body: template.body,
      enabled: template.enabled,
    } : emptyEmailTemplate);
    setEmailTemplateModalId(id);
  };
  const submitEmailTemplate = async () => {
    await handleSaveEmailTemplate(emailTemplateModalId ?? null, emailTemplateForm);
    setEmailTemplateModalId(undefined);
  };

  const currentNav = NAV_ITEMS.find(n => n.id === activeTab || n.children?.some(c => c.id === activeTab));
  const currentSubNav = currentNav?.children?.find(c => c.id === activeTab);
  const isSingleDashboardDate = dashboardStartDate === dashboardEndDate;
  const isDashboardToday = isSingleDashboardDate && dashboardStartDate === today;
  const dashboardScopeLabel = isDashboardToday ? '今日' : '所选时段';
  const dashboardMessageTitle = isDashboardToday
    ? '今日消息数'
    : isSingleDashboardDate
      ? '当日消息数'
      : '消息总数';
  const dashboardUpdatedAt = dashboardData
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date(dashboardData.updated_at))
    : '--:--:--';
  const dashboardStats = [
    {
      title: dashboardMessageTitle,
      value: dashboardData ? dashboardData.metrics.message_count.toLocaleString('zh-CN') : '--',
      ready: true,
    },
    { title: '有效恢复率', value: '--', ready: false },
    {
      title: '独立接待率',
      value: dashboardData ? `${dashboardData.metrics.independent_reception_rate.toFixed(1)}%` : '--',
      ready: true,
    },
    {
      title: '平均响应时间',
      value: dashboardData ? formatResponseTime(dashboardData.metrics.average_response_seconds) : '--',
      ready: true,
    },
    { title: '订单转化率', value: '--', ready: false },
    { title: '满意度', value: '--', ready: false },
    { title: '转人工率', value: '--', ready: false },
    { title: '撤回率', value: '--', ready: false },
  ];
  const categoryColors = ['bg-indigo-500', 'bg-rose-500', 'bg-amber-500', 'bg-emerald-500', 'bg-sky-500'];

  // If we are in detail view, customize header
  const isDetailView = activeTab === 'agent-detail';

  return (
    <div className="flex h-screen bg-[#F8F9FA] text-[#1A1A21] font-sans selection:bg-indigo-100 selection:text-indigo-900">
      {/* Sidebar */}
      {!isDetailView && (
        <motion.aside 
          initial={false}
          animate={{ width: isSidebarCollapsed ? 80 : 260 }}
          className="relative flex flex-col bg-white border-r border-slate-200 z-50 overflow-hidden shrink-0"
        >
          <div className="p-6 h-20 flex items-center gap-3 shrink-0">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shrink-0">
              <Bot className="text-white w-5 h-5" />
            </div>
            {!isSidebarCollapsed && (
              <motion.span 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-violet-600 truncate"
              >
                AI客服后台
              </motion.span>
            )}
          </div>

          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto custom-scrollbar">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const hasChildren = item.children && item.children.length > 0;
              const isExpanded = expandedMenus.includes(item.id);
              const isParentActive = activeTab === item.id || (hasChildren && item.children!.some(c => c.id === activeTab));
              
              return (
                <div key={item.id} className="space-y-1">
                  <button
                    onClick={() => {
                      if (hasChildren) {
                        toggleMenu(item.id);
                      } else {
                        setActiveTab(item.id === 'robot' ? 'robot-list' : item.id);
                        setSelectedQABase(null);
                      }
                    }}
                    className={cn(
                      "w-full flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 group relative",
                      isParentActive && !hasChildren
                        ? "bg-indigo-50 text-indigo-600" 
                        : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                    )}
                  >
                    <Icon className={cn("w-5 h-5 shrink-0 transition-colors", isParentActive ? "text-indigo-600" : "text-slate-400 group-hover:text-slate-700")} />
                    {!isSidebarCollapsed && (
                      <>
                        <span className="font-medium text-[14px] flex-1 text-left">{item.label}</span>
                        {hasChildren && (
                          isExpanded ? <ChevronDown className="w-4 h-4 opacity-50" /> : <ChevronRight className="w-4 h-4 opacity-50" />
                        )}
                      </>
                    )}
                  </button>

                  {hasChildren && isExpanded && !isSidebarCollapsed && (
                    <div className="ml-9 space-y-1 overflow-hidden transition-all">
                        {item.children!.map((child) => {
                        const isChildActive = activeTab === child.id;
                        return (
                          <button
                            key={child.id}
                            onClick={() => {
                              setActiveTab(child.id);
                              setSelectedQABase(null);
                            }}
                            className={cn(
                              "w-full text-left px-4 py-2 rounded-lg text-sm transition-colors",
                              isChildActive
                                ? "bg-indigo-100 text-indigo-600 font-medium" 
                                : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                            )}
                          >
                            {child.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>

          <div className="p-4 border-t border-slate-100 bg-white">
            <button
              type="button"
              onClick={onBack}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 mb-2 rounded-lg bg-indigo-50 text-indigo-600 hover:bg-indigo-100 transition-colors",
                isSidebarCollapsed && "justify-center",
              )}
              id="back-to-messages-btn"
              title="返回消息中心"
            >
              <ArrowLeft className="w-5 h-5 shrink-0" />
              {!isSidebarCollapsed && <span className="text-sm font-bold">返回消息中心</span>}
            </button>
            <button 
              onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
              className="w-full flex items-center justify-center p-2 rounded-lg hover:bg-slate-50 text-slate-400 hover:text-slate-600 transition-colors"
            >
              <ChevronRight className={cn("w-5 h-5 transition-transform duration-300", isSidebarCollapsed ? "" : "rotate-180")} />
            </button>
          </div>
        </motion.aside>
      )}

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header - Hidden in Detail View */}
        {!isDetailView && (
          <header className="h-20 bg-white border-bottom border-slate-200 px-8 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 text-slate-400">
              <button 
                onClick={() => {
                  setActiveTab('dashboard');
                  setSelectedQABase(null);
                  setSelectedPlanId(null);
                }}
                className="hover:text-indigo-600 transition-colors p-1"
              >
                <LayoutDashboard className="w-4 h-4" />
              </button>
              <ChevronRight className="w-4 h-4" />
              <button 
                onClick={() => {
                  if (currentNav) {
                    if (currentNav.children && currentNav.children.length > 0) {
                      setActiveTab(currentNav.children[0].id);
                      setSelectedQABase(null);
                    } else {
                      setActiveTab(currentNav.id);
                      setSelectedQABase(null);
                    }
                  }
                }}
                className={cn(
                  "transition-colors",
                  !currentSubNav ? "text-slate-900 font-medium whitespace-nowrap" : "hover:text-indigo-600 whitespace-nowrap"
                )}
              >
                {currentNav?.label}
              </button>
              {currentSubNav && (
                <>
                  <ChevronRight className="w-4 h-4" />
                  <button 
                    onClick={() => {
                      setActiveTab(currentSubNav.id);
                      setSelectedQABase(null);
                    }}
                    className={cn(
                      "transition-colors",
                      !selectedQABase && activeTab !== 'robot-base' && activeTab !== 'agent-detail' ? "text-slate-900 font-medium" : "hover:text-indigo-600"
                    )}
                  >
                    {currentSubNav.label}
                  </button>
                </>
              )}
              {selectedQABase && (
                <>
                  <ChevronRight className="w-4 h-4" />
                  <span className="text-slate-900 font-medium">{selectedQABase.name}</span>
                </>
              )}
              {(activeTab === 'robot-base' || activeTab === 'agent-detail') && (
                <>
                  <ChevronRight className="w-4 h-4" />
                  <span className="text-slate-900 font-medium">{activeTab === 'robot-base' ? '机器人配置' : '套餐详情'}</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-6">
              <div className="relative hidden md:block">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input 
                  type="text" 
                  placeholder="搜索功能或数据..." 
                  className="pl-10 pr-4 py-2 bg-slate-100 border-none rounded-full text-sm w-64 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                />
              </div>
              <div className="flex items-center gap-4">
                <button className="relative p-2 text-slate-500 hover:bg-slate-50 rounded-full transition-colors">
                  <Bell className="w-5 h-5" />
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border-2 border-white"></span>
                </button>
                <div className="h-8 w-px bg-slate-200 mx-1"></div>
                <button className="flex items-center gap-3 pl-2 pr-1 py-1 rounded-full hover:bg-slate-50 transition-colors border border-transparent hover:border-slate-200">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-white text-xs font-bold">
                    JS
                  </div>
                  <div className="hidden sm:block text-left">
                    <div className="text-sm font-semibold text-slate-900 leading-none">Admin</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">管理员</div>
                  </div>
                </button>
              </div>
            </div>
          </header>
        )}

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
          <AnimatePresence mode="wait">
            {activeTab === 'dashboard' ? (
              <motion.div
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="space-y-8"
              >
                {/* Dashboard Content ... */}
                <div className="flex flex-col gap-6">
                  <div className="flex items-end justify-between">
                    <div>
                      <h1 className="text-3xl font-bold text-slate-900 tracking-tight">数据概览</h1>
                      <p className="text-slate-500 mt-1">实时监控AI客服运行状态与核心业务指标</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <div className="bg-white p-3 rounded-xl border border-slate-100 flex flex-wrap items-center gap-3 shadow-sm">
                      <label className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-600">
                        <Calendar className="w-4 h-4" />
                        <input type="date" value={dashboardStartDate} max={dashboardEndDate} onChange={(event) => setDashboardStartDate(event.target.value)} className="bg-transparent text-sm font-medium tabular-nums outline-none" aria-label="开始日期" />
                      </label>
                      <span className="text-slate-300">~</span>
                      <label className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-600">
                        <Calendar className="w-4 h-4" />
                        <input type="date" value={dashboardEndDate} min={dashboardStartDate} max={today} onChange={(event) => setDashboardEndDate(event.target.value)} className="bg-transparent text-sm font-medium tabular-nums outline-none" aria-label="结束日期" />
                      </label>
                      <button onClick={() => void loadDashboard()} disabled={isLoadingDashboard} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold hover:bg-indigo-700 disabled:opacity-50">
                        {isLoadingDashboard ? '查询中...' : '查询'}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setDashboardRange(today, today)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-600 hover:border-indigo-300 hover:text-indigo-600">今日</button>
                      <button onClick={() => { const yesterday = shiftDate(today, -1); setDashboardRange(yesterday, yesterday); }} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-600 hover:border-indigo-300 hover:text-indigo-600">昨日</button>
                      <button onClick={() => setDashboardRange(shiftDate(today, -6), today)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-600 hover:border-indigo-300 hover:text-indigo-600">近 7 天</button>
                      <button onClick={() => setDashboardRange(shiftDate(today, -29), today)} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-600 hover:border-indigo-300 hover:text-indigo-600">近 30 天</button>
                    </div>
                  </div>
                  {dashboardNotice && <p className="text-sm text-rose-500">{dashboardNotice}</p>}
                </div>

                {/* Stats Grid - Updated Style from Screenshot */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                  {dashboardStats.map((stat, idx) => (
                    <motion.div
                      key={stat.title}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className={cn("group bg-white p-6 rounded-2xl border shadow-sm transition-all duration-300 flex flex-col justify-between min-h-[180px]", stat.ready ? "border-slate-100 hover:shadow-md" : "border-slate-100 bg-slate-50/60")}
                    >
                      <div className="flex justify-between items-start">
                        <div className={cn(
                          "w-10 h-10 rounded-xl flex items-center justify-center transition-colors",
                          getIconBgColor(stat.title)
                        )}>
                          <StatIcon title={stat.title} className={getIconTextColor(stat.title)} />
                        </div>
                        <span className={cn("text-[11px] font-medium px-2 py-1 rounded-md", stat.ready ? "text-slate-400 bg-slate-50" : "text-slate-500 bg-slate-200/70")}>{stat.ready ? dashboardScopeLabel : '开发中'}</span>
                      </div>
                      
                      <div className="mt-4">
                        <div className="text-slate-500 text-sm font-medium mb-1">{stat.title}</div>
                        <div className={cn("text-3xl font-bold tabular-nums tracking-tight", stat.ready ? "text-slate-900" : "text-slate-400")}>{stat.value}</div>
                      </div>

                      <div className="mt-4 pt-4 border-t border-slate-50 flex items-center justify-between">
                        <div className="flex items-center text-slate-400 gap-1.5 text-[11px]">
                          <Activity className={cn("w-3.5 h-3.5", stat.ready && "text-indigo-400")} />
                          <span>{stat.ready ? `更新于 ${dashboardUpdatedAt}` : '暂未接入统计'}</span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>

                {/* Charts Section */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {/* Main Trend Chart */}
                  <div className="lg:col-span-2 bg-white p-8 rounded-2xl border border-slate-200 shadow-sm">
                    <div className="flex justify-between items-center mb-8">
                      <div>
                        <h3 className="text-lg font-bold text-slate-900">流量监控</h3>
                        <p className="text-slate-400 text-xs mt-0.5">{isSingleDashboardDate ? '按小时' : '按天'}展示客户入站消息量</p>
                      </div>
                      <div className="flex gap-4">
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-full bg-indigo-500"></div>
                          <span className="text-xs text-slate-500 font-medium">咨询量</span>
                        </div>
                      </div>
                    </div>
                    <div className="h-[300px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={dashboardData?.traffic ?? []}>
                          <defs>
                            <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.1}/>
                              <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#F1F5F9" />
                          <XAxis 
                            dataKey="label" 
                            axisLine={false} 
                            tickLine={false} 
                            tick={{fill: '#94A3B8', fontSize: 11}}
                            dy={10}
                          />
                          <YAxis 
                            axisLine={false} 
                            tickLine={false} 
                            tick={{fill: '#94A3B8', fontSize: 11}}
                          />
                          <Tooltip 
                            contentStyle={{ 
                              backgroundColor: '#1E293B', 
                              border: 'none', 
                              borderRadius: '12px',
                              color: 'white',
                              fontSize: '12px',
                              boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)'
                            }}
                            itemStyle={{ color: '#E2E8F0' }}
                          />
                          <Area 
                            type="monotone" 
                            dataKey="count" 
                            stroke="#6366f1" 
                            strokeWidth={3}
                            fillOpacity={1} 
                            fill="url(#colorCount)" 
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Right Rail Info */}
                  <div className="space-y-6">
                    <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm h-full flex flex-col">
                      <h3 className="text-lg font-bold text-slate-900 mb-6 font-sans">热门咨询分类</h3>
                      <div className="space-y-5 flex-1">
                        {(dashboardData?.categories ?? []).map((item, index) => (
                          <div key={`${item.type}-${item.category_id ?? item.name}`} className="space-y-2">
                            <div className="flex justify-between text-xs font-semibold">
                              <span className="text-slate-600">{item.name}</span>
                              <span className="text-slate-900">{item.percentage}% · {item.count} 次</span>
                            </div>
                            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                              <motion.div 
                                initial={{ width: 0 }}
                                animate={{ width: `${item.percentage}%` }}
                                transition={{ duration: 1, ease: "easeOut" }}
                                className={cn("h-full rounded-full", categoryColors[index % categoryColors.length])}
                              />
                            </div>
                          </div>
                        ))}
                        {!isLoadingDashboard && (dashboardData?.categories.length ?? 0) === 0 && (
                          <div className="py-16 text-center">
                            <MessageSquare className="w-8 h-8 mx-auto text-slate-300" />
                            <p className="mt-3 text-sm text-slate-400">所选时段暂无知识库命中数据</p>
                          </div>
                        )}
                      </div>
                      <button onClick={() => setIsFullReportModalOpen(true)} className="mt-8 py-3 w-full border border-slate-200 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-50 transition-colors">
                        查看完整报告
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : activeTab === 'robot-list' ? (
              <motion.div
                key="robot-list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">店铺机器人配置</h1>
                    <p className="text-slate-500 mt-1 text-sm">在这里管理您的所有机器人，为其配置模型能力、知识库及策略。</p>
                  </div>
                  <button 
                    onClick={() => openRobotConfig(null)}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all"
                  >
                    <Plus className="w-4 h-4" />
                    新建机器人
                  </button>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                  {robotNotice && <div className="px-6 py-3 border-b border-slate-100 text-sm text-slate-600">{robotNotice}</div>}
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 text-xs font-semibold border-b border-slate-100">
                        <th className="px-6 py-4">机器人名称 / ID</th>
                        <th className="px-6 py-4">模型配置</th>
                        <th className="px-6 py-4">知识库 / 策略</th>
                        <th className="px-6 py-4">生效平台与店铺</th>
                        <th className="px-6 py-4">状态</th>
                        <th className="px-6 py-4 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {robots.map((robot) => (
                        <tr key={robot.id} className="hover:bg-slate-50/50 transition-colors group">
                          <td className="px-6 py-4">
                            <div className="flex flex-col">
                              <span className="text-sm font-bold text-slate-900">{robot.name}</span>
                              <span className="text-[10px] text-slate-400 font-mono mt-0.5">{robot.id}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-xs px-2 py-1 bg-slate-100 text-slate-600 rounded-md font-medium">{robot.model}</span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col gap-1.5">
                              <div className="flex flex-wrap gap-1">
                                {robot.knowledgeBases.map(kb => (
                                  <span key={kb} className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-500 rounded border border-blue-100">{kb}</span>
                                ))}
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {robot.strategies.map(st => (
                                  <span key={st} className="text-[10px] px-1.5 py-0.5 bg-violet-50 text-violet-500 rounded border border-violet-100">{st}</span>
                                ))}
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex flex-col gap-1 items-start">
                              {robot.platformShops.map(scope => (
                                <span key={scope} className="text-xs text-slate-600 truncate max-w-[180px]" title={scope}>
                                  {scope}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className={cn(
                              "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold ring-1",
                              robot.status === 'online'
                                ? "bg-emerald-50 text-emerald-600 ring-emerald-100" 
                                : "bg-slate-100 text-slate-400 ring-slate-200"
                            )}>
                              <span className={cn("w-1 h-1 rounded-full", robot.status === 'online' ? "bg-emerald-500" : "bg-slate-400")} />
                              {robot.status === 'online' ? '在线' : '离线'}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-3 transition-opacity">
                              <button onClick={() => { setTestReplyRobotId(robot.id); setTestReplyText(''); setTestReplyResult(''); setTestReplyDebug(null); setTestReplyMessages([]); }} className="text-indigo-500 hover:text-indigo-600 font-bold text-xs transition-colors">测试回复</button>
                              {robot.status !== 'online' && (
                                <button onClick={() => toggleRobotStatus(robot.id)} className="text-emerald-500 hover:text-emerald-600 font-bold text-xs transition-colors">上线</button>
                              )}
                              {robot.status === 'online' && (
                                <button onClick={() => toggleRobotStatus(robot.id)} className="text-slate-400 hover:text-slate-600 font-bold text-xs transition-colors">下线</button>
                              )}
                              <button onClick={() => openRobotConfig(robot.id)} className="text-indigo-500 hover:text-indigo-600 font-bold text-xs transition-colors">配置</button>
                              <button onClick={() => requestConfirm(`确定删除“${robot.name}”吗？`, () => handleDeleteRobot(robot.id))} className="text-rose-500 hover:text-rose-600 font-bold text-xs transition-colors">删除</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!isLoadingRobots && robots.length === 0 && (
                        <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-slate-400">暂无机器人，请先新建机器人。</td></tr>
                      )}
                      {isLoadingRobots && (
                        <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-slate-400">正在加载机器人配置...</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </motion.div>
            ) : activeTab === 'robot-base' ? (
              <motion.div
                key="robot-base"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-8 max-w-5xl"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={() => setActiveTab('robot-list')}
                      className="p-2 hover:bg-slate-100 rounded-xl text-slate-500 transition-colors"
                    >
                      <ArrowLeft className="w-5 h-5" />
                    </button>
                    <div>
                      <h1 className="text-2xl font-bold text-slate-900 tracking-tight">机器人核心配置</h1>
                      <p className="text-slate-500 mt-1 text-sm">定义机器人的业务目标、应答风格、关联知识库及发布范围。</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button onClick={() => setActiveTab('robot-list')} className="px-6 py-2 border border-slate-200 rounded-xl text-sm font-bold text-slate-600 hover:bg-slate-50 transition-colors">取消</button>
                    <button
                      onClick={() => void handleSaveRobotConfiguration()}
                      disabled={isSavingRobot || !robotName.trim() || (isCustomCustomerAddress && !customerAddress.trim()) || (isCustomSelfAddress && !selfAddress.trim())}
                      className="px-6 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >{isSavingRobot ? '保存中...' : '保存配置'}</button>
                  </div>
                </div>

                {/* Sub-Tabs Navigation */}
                <div className="flex bg-slate-100/50 p-1 rounded-2xl w-fit">
                  {[
                    { id: 'base', label: '1. 基础配置' },
                    { id: 'logic', label: '2. 知识库与策略' },
                    { id: 'scope', label: '3. 关联平台与店铺' }
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setRobotSubTab(tab.id)}
                      className={cn(
                        "px-8 py-2.5 rounded-xl text-sm font-bold transition-all duration-200",
                        robotSubTab === tab.id 
                          ? "bg-white text-indigo-600 shadow-sm" 
                          : "text-slate-400 hover:text-slate-600"
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-8">
                  {robotSubTab === 'base' && (
                    <>
                      {/* Model Configuration */}
                      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                        <div className="flex items-center gap-3 border-b border-slate-50 pb-4">
                          <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center">
                            <Activity className="w-5 h-5 text-indigo-500" />
                          </div>
                          <h3 className="text-lg font-bold text-slate-900">核心模型配置</h3>
                        </div>
                        
                        <div className="grid grid-cols-1 gap-8">
                          <div className="space-y-3">
                            <label className="text-sm font-bold text-slate-700">机器人名称</label>
                            <input
                              value={robotName}
                              onChange={(event) => setRobotName(event.target.value)}
                              maxLength={128}
                              placeholder="请输入机器人名称"
                              className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                            />
                          </div>
                          <div className="space-y-3">
                            <label className="text-sm font-bold text-slate-700">选择底座模型</label>
                            <div className="relative">
                              <select value={robotModel} onChange={(event) => setRobotModel(event.target.value)} className="w-full appearance-none pl-4 pr-10 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all">
                                <option value="deepseek-chat">DeepSeek Chat</option>
                                <option value="deepseek-reasoner">DeepSeek Reasoner</option>
                              </select>
                              <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                            </div>
                          </div>
                          <label className="space-y-3">
                            <span className="text-sm font-bold text-slate-700">模型发散度（Temperature）</span>
                            <input type="number" min="0" max="2" step="0.1" value={robotTemperature} onChange={(event) => setRobotTemperature(Number(event.target.value))} className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                            <span className="block text-xs text-slate-400">数值越高，回复越有创造性；数值越低，回复越稳定。</span>
                          </label>
                          <label className="flex items-center gap-3 cursor-pointer rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                            <input type="checkbox" checked={allowRobotAutoReply} onChange={(event) => setAllowRobotAutoReply(event.target.checked)} className="h-4 w-4 accent-indigo-600" />
                            <span className="text-sm font-bold text-slate-700">启用 AI 自动回复</span>
                          </label>
                        </div>
                      </div>
                      {robotNotice && <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-600">{robotNotice}</div>}

                      {/* Agent Style Section */}
                      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-8">
                        <div className="flex items-center gap-3 border-b border-slate-50 pb-4">
                          <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
                            <User className="w-5 h-5 text-blue-500" />
                          </div>
                          <h3 className="text-lg font-bold text-slate-900">Agent 应答风格</h3>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                          <div className="space-y-6">
                            <h4 className="text-sm font-bold text-slate-800">基础风格</h4>
                            <div className="grid grid-cols-3 gap-3">
                              {[
                                { title: '标准', emoji: '😊' },
                                 { title: '专业', emoji: '🎓' },
                                { title: '随和', emoji: '🐏' },
                              ].map((item) => (
                                 <div 
                                   key={item.title}
                                   onClick={() => setBaseStyle(item.title)}
                                  className={cn(
                                    "p-4 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-pointer",
                                     baseStyle === item.title 
                                      ? "bg-blue-50/50 border-blue-500 ring-1 ring-blue-500" 
                                      : "bg-white border-slate-100 hover:border-slate-200"
                                  )}
                                >
                                  <span className="text-xs font-bold text-slate-900">{item.title}</span>
                                  <span className="text-xl">{item.emoji}</span>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-6">
                            <h4 className="text-sm font-bold text-slate-800">回答长度</h4>
                            <div className="grid grid-cols-3 gap-3">
                              {[
                                { title: '简要', icon: '📝' },
                                 { title: '适中', icon: '📖' },
                                { title: '详细', icon: '📘' },
                              ].map((item) => (
                                 <div 
                                   key={item.title}
                                   onClick={() => setAnswerLength(item.title)}
                                  className={cn(
                                    "p-4 rounded-xl border flex flex-col items-center gap-2 transition-all cursor-pointer",
                                     answerLength === item.title 
                                      ? "bg-blue-50/50 border-blue-500 ring-1 ring-blue-500" 
                                      : "bg-white border-slate-100 hover:border-slate-200"
                                  )}
                                >
                                  <span className="text-xs font-bold text-slate-900">{item.title}</span>
                                  <span className="text-xl">{item.icon}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-4">
                          <h4 className="text-sm font-bold text-slate-800">上下文读取长度</h4>
                          <div className="flex items-center gap-6">
                            <div className="flex-1 max-w-md bg-slate-50 p-4 rounded-xl border border-slate-100 group">
                              <div className="flex items-center justify-between mb-3">
                                <span className="text-xs font-bold text-slate-600">最近对话消息数</span>
                                 <span className="text-sm font-bold text-indigo-600 font-mono px-2 py-0.5 bg-indigo-50 rounded text-indigo-600">{contextLength} 条</span>
                               </div>
                               <input
                                 type="range"
                                 min="1"
                                 max="50"
                                 step="1"
                                 value={contextLength}
                                 onChange={(event) => setContextLength(Number(event.target.value))}
                                 className="w-full accent-indigo-600"
                               />
                            </div>
                            <div className="text-[11px] text-slate-400 max-w-[280px] leading-relaxed">
                               控制机器人应答时参考的历史消息条数；本次客户消息始终保留，可按 1 条精细调整。
                            </div>
                          </div>
                        </div>

                        <div className="space-y-6">
                          <h4 className="text-sm font-bold text-slate-800">称呼设置</h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            <div className="space-y-3">
                              <label className="text-xs font-medium text-slate-400">对客户的称呼</label>
                              <div className="flex flex-wrap gap-2">
                                {['亲亲', '宝宝'].map((tag) => (
                                  <button 
                                    key={tag}
                                    type="button"
                                    onClick={() => { setCustomerAddress(tag); setIsCustomCustomerAddress(false); }}
                                    className={cn(
                                      "px-4 py-1.5 rounded text-xs transition-colors border",
                                      !isCustomCustomerAddress && customerAddress === tag
                                        ? "text-blue-600 border-blue-200 bg-blue-50" 
                                        : "bg-slate-50 text-slate-600 border-transparent hover:bg-slate-100"
                                    )}
                                  >
                                    {tag}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  onClick={() => { if (!isCustomCustomerAddress) setCustomerAddress(''); setIsCustomCustomerAddress(true); }}
                                  className={cn(
                                    "px-4 py-1.5 rounded text-xs transition-colors border",
                                    isCustomCustomerAddress
                                      ? "text-blue-600 border-blue-200 bg-blue-50"
                                      : "bg-slate-50 text-slate-600 border-transparent hover:bg-slate-100",
                                  )}
                                >自定义</button>
                              </div>
                              {isCustomCustomerAddress && (
                                <input
                                  value={customerAddress}
                                  onChange={(event) => setCustomerAddress(event.target.value)}
                                  maxLength={64}
                                  placeholder="请输入对客户的自定义称呼"
                                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white"
                                />
                              )}
                            </div>
                            <div className="space-y-3">
                              <label className="text-xs font-medium text-slate-400">对自己的称呼</label>
                              <div className="flex flex-wrap gap-2">
                                {['在下', '鄙人'].map((tag) => (
                                  <button 
                                    key={tag}
                                    type="button"
                                    onClick={() => { setSelfAddress(tag); setIsCustomSelfAddress(false); }}
                                    className={cn(
                                      "px-4 py-1.5 rounded text-xs transition-colors border",
                                      !isCustomSelfAddress && selfAddress === tag
                                        ? "text-blue-600 border-blue-200 bg-blue-50" 
                                        : "bg-slate-50 text-slate-600 border-transparent hover:bg-slate-100"
                                    )}
                                  >
                                    {tag}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  onClick={() => { if (!isCustomSelfAddress) setSelfAddress(''); setIsCustomSelfAddress(true); }}
                                  className={cn(
                                    "px-4 py-1.5 rounded text-xs transition-colors border",
                                    isCustomSelfAddress
                                      ? "text-blue-600 border-blue-200 bg-blue-50"
                                      : "bg-slate-50 text-slate-600 border-transparent hover:bg-slate-100",
                                  )}
                                >自定义</button>
                              </div>
                              {isCustomSelfAddress && (
                                <input
                                  value={selfAddress}
                                  onChange={(event) => setSelfAddress(event.target.value)}
                                  maxLength={64}
                                  placeholder="请输入客服的自定义称呼"
                                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white"
                                />
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-4">
                          <h4 className="text-sm font-bold text-slate-800">高级效果指令</h4>
                          <textarea 
                            className="w-full h-24 p-4 bg-slate-50 border border-slate-100 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all resize-none"
                            placeholder="描述额外的应答风格需求..."
                            value={advancedInstruction}
                            onChange={(event) => setAdvancedInstruction(event.target.value)}
                            maxLength={2000}
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {robotSubTab === 'logic' && (
                    <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                      <div className="flex items-center gap-3 border-b border-slate-50 pb-4">
                        <div className="w-10 h-10 bg-amber-50 rounded-lg flex items-center justify-center">
                          <Bot className="w-5 h-5 text-amber-500" />
                        </div>
                        <h3 className="text-lg font-bold text-slate-900">知识库与策略 关联</h3>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                        {/* QA Base */}
                        <div className="space-y-4">
                          <label className="text-sm font-bold text-slate-700">QA问答知识库</label>
                          <div className="space-y-2 max-h-[280px] overflow-y-auto pr-2 custom-scrollbar border border-slate-50 p-2 rounded-xl">
                            {robotKnowledgeBases.filter((item) => item.kind === 'qa').map(item => (
                              <label key={item.id} className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors group border border-transparent hover:border-slate-100">
                                <input type="checkbox" className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" checked={selectedQaKBIds.includes(item.id)} onChange={() => toggleKnowledgeBase(setSelectedQaKBIds, item.id)} />
                                <span className="text-sm text-slate-600 group-hover:text-slate-900 flex-1">{item.name}</span>
                              </label>
                            ))}
                            {robotKnowledgeBases.every((item) => item.kind !== 'qa') && <p className="px-4 py-3 text-xs text-slate-400">暂无可用 QA 问答知识库</p>}
                          </div>
                        </div>

                        {/* Product Knowledge Base */}
                        <div className="space-y-4">
                          <label className="text-sm font-bold text-slate-700">产品知识库</label>
                          <div className="space-y-2 max-h-[280px] overflow-y-auto pr-2 custom-scrollbar border border-slate-50 p-2 rounded-xl">
                            {robotKnowledgeBases.filter((item) => item.kind === 'product').map(item => (
                              <label key={item.id} className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors group border border-transparent hover:border-slate-100">
                                <input type="checkbox" className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" checked={selectedProductKBIds.includes(item.id)} onChange={() => toggleKnowledgeBase(setSelectedProductKBIds, item.id)} />
                                <span className="text-sm text-slate-600 group-hover:text-slate-900 flex-1">{item.name}</span>
                              </label>
                            ))}
                            {robotKnowledgeBases.every((item) => item.kind !== 'product') && <p className="px-4 py-3 text-xs text-slate-400">暂无可用产品知识库</p>}
                          </div>
                        </div>

                        {/* Tone Knowledge Base */}
                        <div className="space-y-4">
                          <label className="text-sm font-bold text-slate-700">语气知识库</label>
                          <div className="space-y-2 max-h-[280px] overflow-y-auto pr-2 custom-scrollbar border border-slate-50 p-2 rounded-xl">
                            {robotKnowledgeBases.filter((item) => item.kind === 'tone').map(item => (
                              <label key={item.id} className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors group border border-transparent hover:border-slate-100">
                                <input
                                  type="radio"
                                  name="robot-tone-knowledge-base"
                                  checked={selectedToneKB === item.id}
                                  onChange={() => setSelectedToneKB(item.id)}
                                  className="w-4 h-4 border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                />
                                <span className="text-sm text-slate-600 group-hover:text-slate-900 flex-1">{item.name}</span>
                              </label>
                            ))}
                            {robotKnowledgeBases.every((item) => item.kind !== 'tone') && <p className="px-4 py-3 text-xs text-slate-400">暂无可用语气知识库</p>}
                          </div>
                        </div>
                      </div>

                      {/* Configurations for selected strategies */}
                      <div className="pt-8 border-t border-slate-100 space-y-10">
                        {/* 转分流策略 */}
                        <div className="space-y-6">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <GitMerge className="w-5 h-5 text-indigo-500" />
                              <h3 className="text-lg font-bold text-slate-900">转分流策略</h3>
                              <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-bold">开发中...</span>
                            </div>
                            <button onClick={handleAddRoutingCard} className="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-sm font-bold hover:bg-indigo-100 transition-colors">
                              <Plus className="w-4 h-4" />
                              新增时间段
                            </button>
                          </div>

                          <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-800">
                            当前时间段、分流比例和平台会话转移仅为界面预览，尚未接入 business-api 和平台 RPA，请勿作为已生效策略使用。
                          </div>
                          
                          <div className="space-y-4">
                            {routingCards.map((card) => (
                              <div key={card.id} className="bg-slate-50/50 p-6 rounded-2xl border border-slate-200 shadow-sm space-y-8 relative group">
                                <div className="space-y-4">
                                  <div className="flex items-center justify-between">
                                    <div>
                                      <h3 className="text-base font-bold text-slate-900">启用人机结合时间段</h3>
                                      <p className="text-sm text-slate-500 mt-1">在设定时间内，机器人将优先引导转人，若人工全忙则由机器人接待。</p>
                                    </div>
                                    <div className="flex items-center gap-4">
                                      <div className="w-12 h-6 shrink-0 bg-indigo-500 rounded-full relative cursor-pointer shadow-inner">
                                        <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm"></div>
                                      </div>
                                      <div className="opacity-0 group-hover:opacity-100 transition-opacity -mr-2">
                                        <button onClick={() => handleDeleteRoutingCard(card.id)} className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-colors" title="删除当前时间段卡片">
                                          <Trash2 className="w-4 h-4" />
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-200/60">
                                    <div className="space-y-2">
                                      <label className="text-sm font-bold text-slate-700">开始时间</label>
                                      <input type="time" defaultValue={card.start} className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                                    </div>
                                    <div className="space-y-2">
                                      <label className="text-sm font-bold text-slate-700">结束时间</label>
                                      <input type="time" defaultValue={card.end} className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                                    </div>
                                  </div>
                                </div>

                                <div className="space-y-4 pt-6 border-t border-slate-200/60">
                                  <div>
                                    <h3 className="text-base font-bold text-slate-900">转分流比例</h3>
                                    <p className="text-sm text-slate-500 mt-1">控制机器人会话进入人工队列的比例（0%为全量机器人，100%为全量转人工）。</p>
                                  </div>
                                  <div className="flex items-center gap-4 py-4">
                                    <span className="text-sm font-bold text-slate-400">0%</span>
                                    <input 
                                      type="range" 
                                      className="flex-1 accent-indigo-600" 
                                      min="0" max="100" step="1" 
                                      value={card.ratio} 
                                      onChange={e => handleUpdateRoutingRatio(card.id, parseInt(e.target.value))} 
                                    />
                                    <span className="text-sm font-bold text-slate-600">100%</span>
                                  </div>
                                  <div className="text-center">
                                    <span className="inline-block px-4 py-1.5 bg-indigo-100 text-indigo-700 font-mono font-bold text-lg rounded-xl">{card.ratio}%</span>转人工
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* 机器人安全策略 */}
                        <div className="space-y-6">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <ShieldAlert className="w-5 h-5 text-rose-500" />
                              <h3 className="text-lg font-bold text-slate-900">机器人安全策略</h3>
                            </div>
                            <span className="text-xs font-medium text-slate-400">跟随当前机器人绑定的平台与店铺生效</span>
                          </div>
                          
                          <div className="bg-slate-50/50 p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                            <div className="flex items-center gap-2 pb-4 border-b border-slate-200/70">
                              <ShieldAlert className="w-5 h-5 text-rose-500" />
                              <h4 className="text-base font-bold text-slate-900">违禁词处理策略</h4>
                            </div>
                            <div className="p-4 bg-orange-50/80 rounded-xl border border-orange-100/50 flex items-start gap-3">
                              <Info className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
                              <div>
                                <p className="text-sm text-orange-800">QA 或 AI 回复命中违禁词时，将违禁词替换为预设词后再发送；未配置替换词的旧规则仍使用常规兜底话术。</p>
                              </div>
                            </div>
                            
                            <div className="space-y-4">
                              <label className="text-sm font-bold text-slate-700">添加违禁词替换规则</label>
                              <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3">
                                <input
                                  type="text"
                                  placeholder="违禁词，例如：你好"
                                  value={outboundBlockWordDraft}
                                  maxLength={64}
                                  onChange={(event) => setOutboundBlockWordDraft(event.target.value)}
                                  className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                />
                                <input
                                  type="text"
                                  placeholder="替换为，例如：您好"
                                  value={outboundReplacementDraft}
                                  maxLength={128}
                                  onChange={(event) => setOutboundReplacementDraft(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key !== 'Enter') return;
                                    event.preventDefault();
                                    addOutboundBlockWord();
                                  }}
                                  className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                />
                                <button
                                  type="button"
                                  onClick={addOutboundBlockWord}
                                  disabled={!outboundBlockWordDraft.trim() || !outboundReplacementDraft.trim() || outboundBlockRules.length >= 200}
                                  className="px-5 py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                                >
                                  添加
                                </button>
                              </div>
                              {outboundBlockRules.some((rule) => rule.word.toLocaleLowerCase() === outboundBlockWordDraft.trim().toLocaleLowerCase()) && outboundBlockWordDraft.trim() && (
                                <p className="text-xs text-rose-500">该违禁词已经存在，请先删除原规则再添加。</p>
                              )}
                            </div>

                            <div className="space-y-3">
                              <label className="text-sm font-bold text-slate-700">已配置替换规则 ({outboundBlockRules.length})</label>
                              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                                <div className="grid grid-cols-[1fr_1fr_80px_80px] gap-3 px-4 py-2.5 bg-slate-50 text-xs font-bold text-slate-500">
                                  <span>违禁词</span><span>替换为</span><span>状态</span><span>操作</span>
                                </div>
                                {outboundBlockRules.map((rule) => (
                                  <div key={rule.word.toLocaleLowerCase()} className="grid grid-cols-[1fr_1fr_80px_80px] gap-3 items-center px-4 py-3 border-t border-slate-100 text-sm">
                                    <span className="font-medium text-rose-600 break-all">{rule.word}</span>
                                    <span className={cn("break-all", rule.replacement ? "text-slate-700" : "text-orange-500")}>{rule.replacement || '待补充（旧规则）'}</span>
                                    <button
                                      type="button"
                                      onClick={() => setOutboundBlockRules((current) => current.map((item) => item.word === rule.word ? { ...item, enabled: !item.enabled } : item))}
                                      className={cn("text-xs font-bold", rule.enabled ? "text-emerald-600" : "text-slate-400")}
                                    >
                                      {rule.enabled ? '已启用' : '已停用'}
                                    </button>
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setOutboundBlockWordDraft(rule.word);
                                          setOutboundReplacementDraft(rule.replacement);
                                          setOutboundBlockRules((current) => current.filter((item) => item.word !== rule.word));
                                        }}
                                        className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                                        title="编辑规则"
                                      ><Pencil className="w-4 h-4" /></button>
                                      <button type="button" onClick={() => setOutboundBlockRules((current) => current.filter((item) => item.word !== rule.word))} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors" title="删除规则"><Trash2 className="w-4 h-4" /></button>
                                    </div>
                                  </div>
                                ))}
                                {outboundBlockRules.length === 0 && <div className="px-4 py-6 border-t border-slate-100 text-center text-xs text-slate-400">暂无违禁词替换规则</div>}
                              </div>
                          </div>

                        </div>
                      </div>

                          <div className="space-y-3">
                            <div className="flex items-center gap-2">
                              <ShieldAlert className="w-5 h-5 text-orange-500" />
                              <h4 className="text-base font-bold text-slate-900">敏感词拦截策略</h4>
                            </div>
                            <div className="bg-slate-50/50 p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                              <div className="p-4 bg-orange-50/80 rounded-xl border border-orange-100/50 flex items-start gap-3">
                                <Info className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
                                <p className="text-sm text-orange-800">客户消息命中敏感词后，立即标记为待人工处理，不再进入 QA 匹配或 AI 回复流程。</p>
                              </div>
                            
                            <div className="space-y-4">
                              <label className="text-sm font-bold text-slate-700">添加敏感词 (按回车键添加)</label>
                              <input 
                                type="text" 
                                placeholder="输入敏感词..." 
                                value={sensitiveWordDraft}
                                maxLength={64}
                                onChange={(event) => setSensitiveWordDraft(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key !== 'Enter') return;
                                  event.preventDefault();
                                  addSensitiveWord();
                                }}
                                className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                              />
                            </div>
                            
                            <div className="space-y-3">
                              <label className="text-sm font-bold text-slate-700">已配置敏感词 ({inboundSensitiveWords.length})</label>
                              <div className="flex flex-wrap gap-2">
                                {inboundSensitiveWords.map(word => (
                                  <div key={word} className="flex items-center gap-2 pl-3 pr-2 py-1.5 bg-orange-100 border border-orange-200 text-orange-700 rounded-lg text-sm font-medium">
                                    {word}
                                    <button type="button" onClick={() => setInboundSensitiveWords((current) => current.filter((item) => item !== word))} className="p-1 hover:bg-orange-200/50 rounded transition-colors"><Trash2 className="w-3 h-3" /></button>
                                  </div>
                                ))}
                                {inboundSensitiveWords.length === 0 && <span className="text-xs text-slate-400">暂无敏感词</span>}
                              </div>
                            </div>

                            <div className="pt-2">
                              <div className="flex items-center justify-between bg-white px-4 py-3 border border-slate-200 rounded-xl">
                                <span className="text-sm font-bold text-slate-700">命中后标记待人工处理，并停止机器人处理该会话</span>
                                <div className="w-12 h-6 bg-indigo-500 rounded-full relative shadow-inner" title="当前版本固定启用">
                                  <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm"></div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* 兜底策略 */}
                        <div className="space-y-6">
                          <div className="flex items-center gap-2 mb-2">
                            <LifeBuoy className="w-5 h-5 text-emerald-500" />
                            <h3 className="text-lg font-bold text-slate-900">兜底策略</h3>
                          </div>
                          
                          <div className="space-y-4">
                            {/* 常规兜底话术 Card */}
                            <div className="bg-slate-50/50 p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                              <div className="space-y-1">
                                <h3 className="text-base font-bold text-slate-900">常规兜底话术</h3>
                                <p className="text-sm text-slate-500">当机器人无法从知识库中找到确切答案时使用的默认回复。</p>
                              </div>
                              <div className="space-y-4">
                                <div className="space-y-2">
                                  <label className="text-sm font-bold text-slate-700">输入默认兜底回答：</label>
                              <textarea
                                className="w-full h-24 p-4 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all resize-none"
                                value={fallbackReplyText}
                                onChange={(event) => setFallbackReplyText(event.target.value)}
                              />
                                </div>
                                <div className="flex items-center justify-between bg-white px-4 py-3 border border-slate-200 rounded-xl">
                                  <div>
                                    <span className="block text-sm font-bold text-slate-700">发出兜底话术后标记待人工处理，并停止机器人处理该会话</span>
                                    <span className="block mt-1 text-xs text-slate-400">仅标记消息中心会话，不调用平台的“转移会话”功能。</span>
                                  </div>
                                  <button type="button" onClick={() => setFallbackMarkHumanRequired((value) => !value)} className={cn("w-12 h-6 shrink-0 rounded-full relative shadow-inner transition-colors", fallbackMarkHumanRequired ? "bg-indigo-500" : "bg-slate-300")} title="发送任务入队后立即标记待人工处理">
                                    <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm"></div>
                                  </button>
                                </div>
                              </div>
                            </div>

                            {/* 超时安抚话术 Card */}
                            <div className="bg-slate-50/50 p-6 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                              <div className="space-y-1">
                                <h3 className="text-base font-bold text-slate-900">超时安抚话术</h3>
                                <p className="text-sm text-slate-500">正式回复超过设定时间仍未发送时，先发送一次安抚消息，正式回复继续执行。</p>
                              </div>
                              <div className="space-y-4 pt-2">
                                <div className="space-y-2">
                                  <label className="text-sm font-bold text-slate-700">设置机器人未响应时间 (秒)</label>
                                  <input type="number" value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Math.max(1, Math.min(60, Number(event.target.value) || 1)))} min="1" max="60" className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                                </div>
                                <div className="space-y-2">
                                  <label className="text-sm font-bold text-slate-700">输入默认安抚话术：</label>
                                  <textarea 
                                    className="w-full h-24 p-4 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-all resize-none"
                                    value={timeoutReplyText}
                                    onChange={(event) => setTimeoutReplyText(event.target.value)}
                                  />
                                </div>
                                <div className="flex items-center justify-between bg-white px-4 py-3 border border-slate-200 rounded-xl">
                                  <span className="text-sm font-bold text-slate-700">启用超时安抚（只发送一次，不打断正式回复）</span>
                                  <button type="button" onClick={() => setTimeoutEnabled((value) => !value)} className={cn("w-12 h-6 rounded-full relative shadow-inner transition-colors", timeoutEnabled ? "bg-indigo-500" : "bg-slate-300")}>
                                    <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm"></div>
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                      </div>
                    </div>
                  )}

                  {robotSubTab === 'scope' && (
                    <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                      <div className="flex items-center gap-3 border-b border-slate-50 pb-4">
                        <div className="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center">
                          <ShoppingBag className="w-5 h-5 text-emerald-500" />
                        </div>
                        <h3 className="text-lg font-bold text-slate-900">关联平台与店铺</h3>
                      </div>

                      <div className="space-y-6">
                        <div className="space-y-3">
                          <label className="text-sm font-bold text-slate-700">选择生效平台（可多选）</label>
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                            {platformOptions.map((platform) => (
                              <label key={platform} className={cn(
                                "flex items-center gap-2 px-3 py-3 rounded-xl border cursor-pointer transition-colors",
                                selectedPlatforms.includes(platform) ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                              )}>
                                <input
                                  type="checkbox"
                                  checked={selectedPlatforms.includes(platform)}
                                  onChange={() => togglePlatform(platform)}
                                  className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                />
                                <span className="text-sm font-medium">{platform}</span>
                              </label>
                            ))}
                          </div>
                        </div>

                        {selectedPlatforms.length > 0 && !selectedPlatforms.includes('全部平台') && (
                          <div className="pt-6 border-t border-slate-100 space-y-5">
                            <div>
                              <h4 className="text-sm font-bold text-slate-700">选择平台对应店铺（可多选）</h4>
                              <p className="text-xs text-slate-400 mt-1">每个平台可选择一个、多个或全部店铺。</p>
                            </div>
                            {selectedPlatforms.map((platform) => (
                              <div key={platform} className="space-y-3">
                                <div className="flex items-center gap-2">
                                  <span className="w-6 h-6 rounded-md bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center">{platform === '拼多多' ? '拼' : platform === '千牛' ? '千' : platform.slice(0, 1)}</span>
                                  <span className="text-sm font-bold text-slate-800">{platform}</span>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pl-8">
                                  {(platformShopOptions[platform] ?? []).map((shop) => (
                                    <label key={shop} className={cn(
                                      "flex items-center gap-2 px-3 py-2.5 rounded-lg border cursor-pointer transition-colors",
                                      (selectedShops[platform] ?? []).includes(shop) ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                    )}>
                                      <input
                                        type="checkbox"
                                        checked={(selectedShops[platform] ?? []).includes(shop)}
                                        onChange={() => toggleShop(platform, shop)}
                                        className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                      />
                                      <span className="text-sm">{shop}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {selectedPlatforms.includes('全部平台') && (
                          <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-xl text-sm text-indigo-700">已选择全部平台，无需再配置具体店铺。</div>
                        )}
                        {selectedPlatforms.length === 0 && (
                          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-500">请至少选择一个生效平台。</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            ) : activeTab === 'knowledge-product' ? (
              <motion.div
                key="knowledge-product"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                {selectedProductKB ? (
                  <div className="space-y-6">
                    <div className="flex items-center gap-4">
                      <button onClick={closeProductKBConfig} className="p-2 hover:bg-slate-100 rounded-xl text-slate-500 transition-colors" title="返回知识库列表">
                        <ArrowLeft className="w-5 h-5" />
                      </button>
                      <div>
                        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{selectedProductKB.name}</h1>
                        <p className="text-slate-500 mt-1 text-sm">导入并管理产品文档，为机器人提供检索内容。</p>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
                      <div className="flex flex-col md:flex-row md:items-end gap-4">
                        <label className="space-y-2 flex-1">
                          <span className="text-sm font-bold text-slate-700">知识库名称</span>
                          <input
                            value={productKBName}
                            onChange={(event) => setProductKBName(event.target.value)}
                            maxLength={128}
                            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white"
                          />
                        </label>
                        <button
                          onClick={() => void handleUpdateProductKB()}
                          disabled={isSavingProductKB || !productKBName.trim() || productKBName.trim() === selectedProductKB.name}
                          className="px-5 py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                        >{isSavingProductKB ? '保存中...' : '保存名称'}</button>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-lg font-bold text-slate-900">导入文档</h2>
                          <p className="text-sm text-slate-500 mt-1">支持 TXT、MD、CSV、JSON、HTML、PDF、DOCX、XLSX、XLSM 文件，导入时会解析并切片。</p>
                        </div>
                        <FileText className="w-7 h-7 text-indigo-500" />
                      </div>
                      <label className={cn(
                        "border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-colors",
                        selectedProductFile ? "border-indigo-300 bg-indigo-50/50" : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50"
                      )}>
                        <UploadCloud className="w-8 h-8 text-indigo-500 mb-3" />
                        <span className="text-sm font-bold text-slate-700">{selectedProductFile ? selectedProductFile.name : '点击选择文档'}</span>
                        <span className="text-xs text-slate-400 mt-2">文件会上传到本地知识库服务，解析结果不会暴露原始文件路径。</span>
                        <input type="file" className="hidden" accept=".txt,.md,.csv,.json,.html,.pdf,.docx,.xlsx,.xlsm" onChange={(event) => selectProductFile(event.target.files?.[0] ?? null)} />
                      </label>
                      {isImportingProductDocument && (
                        <div className="space-y-2">
                          <div className="flex justify-between text-xs font-bold text-slate-500"><span>导入进度</span><span>{productImportProgress}%</span></div>
                          <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className="h-full bg-indigo-600 transition-all" style={{ width: `${productImportProgress}%` }} /></div>
                        </div>
                      )}
                      {isLoadingProductDocuments && <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">正在读取知识库文档...</div>}
                      {productImportNotice && <div className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-700">{productImportNotice}</div>}
                      <div className="flex justify-end">
                        <button onClick={handleImportProductDocument} disabled={!selectedProductFile || isImportingProductDocument || isLoadingProductDocuments} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
                          <UploadCloud className="w-4 h-4" />
                          {isImportingProductDocument ? '导入中...' : '导入文档'}
                        </button>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                      <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between">
                        <div><h2 className="text-lg font-bold text-slate-900">已导入文档</h2><p className="text-sm text-slate-500 mt-1">共 {selectedProductKB.count} 份文档</p></div>
                        <button onClick={() => void refreshProductDocuments()} disabled={isLoadingProductDocuments} className="flex items-center gap-2 text-xs font-bold text-indigo-600 disabled:opacity-50"><RefreshCw className={cn("w-3.5 h-3.5", isLoadingProductDocuments && "animate-spin")} />刷新状态</button>
                      </div>
                      {(productDocuments[selectedProductKB.id] ?? []).length === 0 ? (
                        <div className="py-14 text-center text-sm text-slate-400">暂无文档，请先导入产品资料</div>
                      ) : (
                        <div className="overflow-x-auto custom-scrollbar">
                        <table className="w-full min-w-[920px] text-left border-collapse">
                          <thead><tr className="bg-slate-50 text-slate-500 text-xs font-semibold border-b border-slate-100"><th className="px-6 py-4">文档名称</th><th className="px-6 py-4">格式</th><th className="px-6 py-4">大小</th><th className="px-6 py-4">切片数</th><th className="px-6 py-4">状态</th><th className="px-6 py-4">最后更新</th><th className="px-6 py-4 text-right">操作</th></tr></thead>
                          <tbody className="divide-y divide-slate-100">{(productDocuments[selectedProductKB.id] ?? []).map((document) => (
                            <tr key={document.id} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-4"><button type="button" onClick={() => { setProductDocumentTab('chunks'); setProductDocumentSearch(''); void openProductDocumentDetail(document); }} className="flex items-center gap-3 text-left group"><FileText className="w-4 h-4 text-slate-400 group-hover:text-indigo-500" /><span className="text-sm font-bold text-slate-800 group-hover:text-indigo-600">{document.name}</span></button></td>
                              <td className="px-6 py-4 text-xs text-slate-500">{document.format}</td>
                              <td className="px-6 py-4 text-sm text-slate-500">{document.size}</td>
                              <td className="px-6 py-4 text-sm text-slate-500">{document.chunkCount} 个</td>
                              <td className="px-6 py-4"><span className={cn("inline-flex items-center gap-1.5 text-xs font-bold", document.status === '已解析' ? "text-emerald-600" : "text-amber-600")}>{document.status === '已解析' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <RefreshCw className="w-3.5 h-3.5" />}{document.status}</span></td>
                              <td className="px-6 py-4 text-sm text-slate-500">{document.date}</td>
                              <td className="px-6 py-4 text-right"><div className="flex items-center justify-end gap-4"><button type="button" onClick={() => { setProductDocumentTab('chunks'); setProductDocumentSearch(''); void openProductDocumentDetail(document); }} className="text-indigo-600 hover:text-indigo-700 font-bold text-xs">查看</button><button onClick={() => requestConfirm(`确定删除“${document.name}”吗？`, () => handleDeleteProductDocument(document.id))} className="text-rose-500 hover:text-rose-600 font-bold text-xs">删除</button></div></td>
                            </tr>
                          ))}</tbody>
                        </table>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                <>
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">产品知识库</h1>
                    <p className="text-slate-500 mt-1 text-sm">集中管理产品资料，为机器人提供可复用的产品知识。</p>
                  </div>
                  <button onClick={() => setIsAddProductKBModalOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all">
                    <Plus className="w-4 h-4" />
                    新增知识库
                  </button>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 text-xs font-semibold border-b border-slate-100">
                        <th className="px-6 py-4">知识库名称</th>
                        <th className="px-6 py-4">文档数</th>
                        <th className="px-6 py-4">同步状态</th>
                        <th className="px-6 py-4">最后更新</th>
                        <th className="px-6 py-4 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {productBases.map((kb) => (
                        <tr key={kb.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-6 py-4">
                            <span className="text-sm font-bold text-slate-900">{kb.name}</span>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-500">{kb.count} 份</td>
                          <td className="px-6 py-4">
                            <span className={cn(
                              "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold ring-1",
                              kb.status === '已同步' 
                                ? "bg-emerald-50 text-emerald-600 ring-emerald-100" 
                                : "bg-blue-50 text-blue-600 ring-blue-100"
                            )}>
                              {kb.status === '同步中' ? <RefreshCw className="w-3 h-3 animate-spin inline" /> : <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
                              {kb.status}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-500">{kb.date}</td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-3">
                              <button onClick={() => openProductKBConfig(kb.id)} className="text-indigo-500 hover:text-indigo-600 font-bold text-xs transition-colors">查看</button>
                              <button onClick={() => openProductKBConfig(kb.id)} className="text-slate-400 hover:text-slate-600 font-bold text-xs transition-colors">配置</button>
                              <button onClick={() => requestConfirm(`确定删除“${kb.name}”吗？`, () => handleDeleteProductKB(kb.id))} className="text-rose-500 hover:text-rose-600 font-bold text-xs transition-colors">删除</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!isLoadingProductKB && productBases.length === 0 && (
                        <tr><td colSpan={5} className="px-6 py-12 text-center text-sm text-slate-400">暂无产品知识库</td></tr>
                      )}
                    </tbody>
                  </table>
                  {isLoadingProductKB && <div className="px-6 py-8 text-center text-sm text-slate-400">正在加载产品知识库...</div>}
                </div>
                {productKBNotice && <div className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-700">{productKBNotice}</div>}
                </>
                )}
              </motion.div>
            ) : activeTab === 'knowledge-qa' ? (
              <motion.div
                key="knowledge-qa"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                {selectedQABase ? (
                  <div className="space-y-6">
                    {qaNotice && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{qaNotice}</div>}
                    <div className="flex items-center gap-4">
                      <button 
                        onClick={() => setSelectedQABase(null)}
                        className="p-2 hover:bg-slate-100 rounded-xl text-slate-500 transition-colors"
                      >
                        <ArrowLeft className="w-5 h-5" />
                      </button>
                      <div>
                        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{selectedQABase.name}</h1>
                        <p className="text-slate-500 mt-1 text-sm">集中维护可被多个机器人复用的问答内容</p>
                      </div>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-6">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                          <h3 className="text-lg font-bold text-slate-900">问答列表</h3>
                          <p className="mt-1 text-xs text-slate-400">共 {qaTotal} 条问答</p>
                        </div>
                        <button onClick={() => { setShowQaCategoryCreator(false); openAddQAItem(); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all">
                          <Plus className="w-4 h-4" />
                          添加问答
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <label className="flex min-w-[220px] items-center gap-2">
                          <span className="shrink-0 text-xs font-bold text-slate-500">分类</span>
                          <select
                            aria-label="筛选问答分类"
                            value={qaCategoryFilter}
                            onChange={(event) => changeQaCategoryFilter(event.target.value)}
                            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:ring-2 focus:ring-indigo-500"
                          >
                            <option value="all">全部分类（{selectedQABase.count}）</option>
                            {qaCategories.map((category) => (
                              <option key={category.id} value={category.id}>{category.name}（{category.item_count}）</option>
                            ))}
                            {selectedQABase.count > qaCategories.reduce((sum, category) => sum + category.item_count, 0) && (
                              <option value="uncategorized">未分类（{selectedQABase.count - qaCategories.reduce((sum, category) => sum + category.item_count, 0)}）</option>
                            )}
                          </select>
                        </label>
                        <form
                          onSubmit={(event) => { event.preventDefault(); submitQaSearch(); }}
                          className="flex min-w-[260px] flex-1 items-center gap-2"
                        >
                          <div className="relative min-w-0 flex-1">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <input
                              type="search"
                              aria-label="搜索问答"
                              placeholder="搜索问题、关键词或答案"
                              value={qaKeywordDraft}
                              onChange={(event) => setQaKeywordDraft(event.target.value)}
                              className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                          </div>
                          <button type="submit" className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100">搜索</button>
                        </form>
                      </div>
                      
                      <div className="border border-slate-200 rounded-xl overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="bg-slate-50 text-slate-500 text-xs font-semibold border-b border-slate-200">
                              <th className="px-6 py-4">权重</th>
                              <th className="px-6 py-4">分类</th>
                              <th className="px-6 py-4 w-1/5">问题</th>
                              <th className="px-6 py-4 w-1/5">关键词</th>
                              <th className="px-6 py-4 w-1/5">答案</th>
                              <th className="px-6 py-4">图片</th>
                              <th className="px-6 py-4">调用次数</th>
                              <th className="px-6 py-4">启用状态</th>
                              <th className="px-6 py-4 text-right">操作</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {isLoadingQA && <tr><td colSpan={9} className="px-6 py-10 text-center text-sm text-slate-400">正在加载问答...</td></tr>}
                            {!isLoadingQA && qaItems.length === 0 && <tr><td colSpan={9} className="px-6 py-10 text-center text-sm text-slate-400">当前条件下暂无问答</td></tr>}
                            {!isLoadingQA && qaItems.map((item) => (
                              <tr key={item.id} className="hover:bg-slate-50/50 transition-colors">
                                <td className="px-6 py-4 text-sm font-mono text-slate-600">{item.weight}</td>
                                <td className="px-6 py-4 text-sm font-medium text-slate-700">{item.category || '未分类'}</td>
                                <td className="px-6 py-4 text-sm font-bold text-slate-900">{item.question}</td>
                                <td className="px-6 py-4 text-xs text-slate-500 max-w-[150px]">
                                  <div className="flex flex-col gap-1">
                                    {item.keywords.split(/[、,，\n]/).filter(Boolean).map((s, i) => (
                                      <span key={i} className="truncate truncate bg-slate-50 px-2 py-1 rounded text-slate-600 border border-slate-100" title={s}>{s}</span>
                                    ))}
                                  </div>
                                </td>
                                <td className="px-6 py-4 text-xs text-slate-500 truncate max-w-[200px]">{item.answer}</td>
                                <td className="px-6 py-4 text-xs text-slate-500">
                                  {item.imageUrl ? (
                                    <ImagePreview src={item.imageUrl} alt="问答图片" />
                                  ) : <span className="text-slate-400">无</span>}
                                </td>
                                <td className="px-6 py-4 text-sm font-mono text-slate-600">{item.calls}</td>
                                <td className="px-6 py-4">
                                  <div className="flex justify-end">
                                    <div onClick={() => toggleQAItem(item.id)} className={`w-10 h-5 rounded-full relative cursor-pointer shadow-inner ${item.enabled ? 'bg-indigo-500' : 'bg-slate-300'}`}>
                                      <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all shadow-sm ${item.enabled ? 'right-0.5' : 'left-0.5'}`}></div>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-6 py-4 text-right">
                                  <div className="flex items-center justify-end gap-3">
                                    <button onClick={() => { setShowQaCategoryCreator(false); openEditQAItem(item.id); }} className="text-indigo-500 hover:text-indigo-600 font-bold text-xs transition-colors">编辑</button>
                                    <button onClick={() => requestConfirm('确定删除这条问答吗？', () => handleDeleteQAItem(item.id))} className="text-rose-500 hover:text-rose-600 font-bold text-xs transition-colors">删除</button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
                        <span>第 {qaPage} / {qaPageCount} 页</span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            title="上一页"
                            onClick={() => setQaPage(Math.max(1, qaPage - 1))}
                            disabled={qaPage <= 1 || isLoadingQA}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="下一页"
                            onClick={() => setQaPage(Math.min(qaPageCount, qaPage + 1))}
                            disabled={qaPage >= qaPageCount || isLoadingQA}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between">
                      <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">QA问答知识库</h1>
                        <p className="text-slate-500 mt-1 text-sm">配置店铺常见的咨询问答对，覆盖售后、物流、发票等通用场景。</p>
                      </div>
                      <button onClick={() => setIsAddQABaseModalOpen(true)} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all">
                        <Plus className="w-4 h-4" />
                        新增知识库
                      </button>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-slate-50 text-slate-500 text-xs font-semibold border-b border-slate-100">
                            <th className="px-6 py-4">问答库名称</th>
                            <th className="px-6 py-4">问答总数</th>
                            <th className="px-6 py-4">最后更新</th>
                            <th className="px-6 py-4 text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {qaBases.map((qa) => (
                            <tr key={qa.id} className="hover:bg-slate-50/50 transition-colors">
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-3">
                                  <span className="text-sm font-bold text-slate-900">{qa.name}</span>
                                </div>
                              </td>
                              <td className="px-6 py-4">
                                <span className="text-sm text-slate-500">{qa.count} 条</span>
                              </td>
                              <td className="px-6 py-4 text-sm text-slate-500">{qa.date}</td>
                              <td className="px-6 py-4 text-right">
                                <div className="flex items-center justify-end gap-3">
                                  <button onClick={() => setSelectedQABase(qa)} className="text-indigo-500 hover:text-indigo-600 font-bold text-xs transition-colors">管理问答</button>
                                  <button className="text-slate-400 hover:text-slate-600 font-bold text-xs transition-colors">导入</button>
                                  <button className="text-slate-400 hover:text-slate-600 font-bold text-xs transition-colors">导出</button>
                                  <button onClick={() => requestConfirm(`确定删除“${qa.name}”吗？删除后其中的问答也会一并移除。`, () => handleDeleteQABase(qa.id))} className="text-rose-500 hover:text-rose-600 font-bold text-xs transition-colors">删除</button>
                                </div>
                              </td>
                            </tr>
                          ))}
                          {!isLoadingQA && qaBases.length === 0 && (
                            <tr><td colSpan={4} className="px-6 py-10 text-center text-sm text-slate-400">暂无 QA 问答知识库</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </motion.div>
            ) : activeTab === 'knowledge-tone' ? (
              <motion.div
                key="knowledge-tone"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">语气知识库</h1>
                    <p className="text-slate-500 mt-1 text-sm">管理机器人回复时可复用的表达风格和语气规范。</p>
                  </div>
                  <button onClick={openAddToneKB} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all">
                    <Plus className="w-4 h-4" />
                    新增知识库
                  </button>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 text-slate-500 text-xs font-semibold border-b border-slate-100">
                        <th className="px-6 py-4">知识库名称</th>
                        <th className="px-6 py-4">最后更新</th>
                        <th className="px-6 py-4 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {toneBases.map((base) => (
                        <tr key={base.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-6 py-4">
                            <span className="text-sm font-bold text-slate-900">{base.name}</span>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-500">{base.date}</td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-3">
                              <button onClick={() => openEditToneKB(base.id)} className="text-indigo-500 hover:text-indigo-600 font-bold text-xs transition-colors">编辑</button>
                              <button onClick={() => requestConfirm(`确定删除“${base.name}”吗？`, () => handleDeleteToneKB(base.id))} className="text-rose-500 hover:text-rose-600 font-bold text-xs transition-colors">删除</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!isLoadingToneKB && toneBases.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-6 py-12 text-center text-sm text-slate-400">暂无语气知识库</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {isLoadingToneKB && <div className="px-6 py-8 text-center text-sm text-slate-400">正在加载语气知识库...</div>}
                </div>
                {toneKBNotice && <p className="text-sm text-slate-500">{toneKBNotice}</p>}
              </motion.div>
            ) : activeTab === 'email' ? (
              <motion.div
                key="email"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="space-y-8 max-w-6xl"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">邮件服务</h1>
                    <p className="text-slate-500 mt-1 text-sm">配置 SMTP 发件账号和资料邮件模板。授权码保存后不会再明文显示。</p>
                  </div>
                </div>
                {isLoadingEmail ? <div className="py-20 text-center text-sm text-slate-500">正在加载邮件配置...</div> : (
                  <>
                    <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
                      <div className="flex items-center justify-between">
                        <div><h2 className="text-lg font-bold text-slate-900">SMTP 配置</h2><p className="text-xs text-slate-500 mt-1">支持 QQ 邮箱、Gmail 和自定义 SMTP</p></div>
                        <label className="flex items-center gap-3 text-sm font-bold text-slate-700"><input type="checkbox" checked={emailConfig.enabled} onChange={(event) => updateEmailConfig('enabled', event.target.checked)} className="w-4 h-4 accent-indigo-600" />启用邮件服务</label>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <label className="space-y-2"><span className="text-sm font-bold text-slate-700">邮件服务商</span><select value={emailConfig.provider} onChange={(event) => applyEmailProviderDefaults(event.target.value as 'qq' | 'gmail' | 'custom')} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm bg-white"><option value="qq">QQ 邮箱</option><option value="gmail">Gmail</option><option value="custom">自定义 SMTP</option></select></label>
                        <label className="space-y-2"><span className="text-sm font-bold text-slate-700">发件邮箱</span><input type="email" value={emailConfig.sender_email} onChange={(event) => updateEmailConfig('sender_email', event.target.value)} placeholder="service@example.com" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" /></label>
                        <label className="space-y-2"><span className="text-sm font-bold text-slate-700">SMTP Host</span><input value={emailConfig.smtp_host} onChange={(event) => updateEmailConfig('smtp_host', event.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" /></label>
                        <label className="space-y-2"><span className="text-sm font-bold text-slate-700">SMTP 端口</span><input type="number" min={1} max={65535} value={emailConfig.smtp_port} onChange={(event) => updateEmailConfig('smtp_port', Number(event.target.value))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" /></label>
                        <label className="space-y-2"><span className="text-sm font-bold text-slate-700">安全方式</span><select value={emailConfig.security} onChange={(event) => updateEmailConfig('security', event.target.value as 'ssl' | 'starttls' | 'none')} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm bg-white"><option value="ssl">SSL</option><option value="starttls">STARTTLS</option><option value="none">无加密</option></select></label>
                        <label className="space-y-2"><span className="text-sm font-bold text-slate-700">授权码 / 应用密码</span><input type="password" value={emailConfig.auth_code} onChange={(event) => updateEmailConfig('auth_code', event.target.value)} placeholder={emailAuthCodeSaved ? '已保存，留空保持不变' : '请输入 SMTP 授权码'} autoComplete="new-password" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" /></label>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto_auto] md:items-end gap-4 rounded-xl bg-slate-50 p-4">
                        <label className="space-y-2 flex-1"><span className="text-sm font-bold text-slate-700">测试收件邮箱</span><input type="email" value={emailTestRecipient} onChange={(event) => setEmailTestRecipient(event.target.value)} placeholder="recipient@example.com" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm bg-white" /></label>
                        <label className="space-y-2"><span className="text-sm font-bold text-slate-700">测试邮件模板</span><select value={emailTestTemplateId} onChange={(event) => setEmailTestTemplateId(event.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm bg-white"><option value="">使用默认测试正文</option>{emailTemplates.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                        <button onClick={() => void handleTestEmailConfig(emailTestRecipient, emailTestTemplateId || undefined)} disabled={isTestingEmail || !emailTestRecipient || !emailConfig.enabled} className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-700 disabled:opacity-50">{isTestingEmail ? '发送中...' : '发送测试邮件'}</button>
                        <button onClick={() => void handleSaveEmailConfig()} disabled={isSavingEmail || !emailConfig.sender_email || !emailConfig.smtp_host} className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold disabled:opacity-50">{isSavingEmail ? '保存中...' : '保存配置'}</button>
                      </div>
                      {emailNotice && <div className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-700">{emailNotice}</div>}
                    </div>

                    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                      <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100"><div><h2 className="text-lg font-bold text-slate-900">邮件模板</h2><p className="text-xs text-slate-500 mt-1">模板识别别名会在阶段 D 用于邮件意图路由</p></div><button onClick={() => openEmailTemplateModal(null)} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold"><Plus className="w-4 h-4" />新增模板</button></div>
                      <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr className="bg-slate-50 text-xs text-slate-500"><th className="px-6 py-4">模板名称 / ID</th><th className="px-6 py-4">业务场景</th><th className="px-6 py-4">识别别名</th><th className="px-6 py-4">主题</th><th className="px-6 py-4">状态</th><th className="px-6 py-4 text-right">操作</th></tr></thead><tbody className="divide-y divide-slate-100">{emailTemplates.map((template) => <tr key={template.id}><td className="px-6 py-4"><p className="text-sm font-bold text-slate-900">{template.name}</p><p className="text-xs font-mono text-slate-400 mt-1">{template.template_key}</p></td><td className="px-6 py-4 text-sm text-slate-600">{template.scene}</td><td className="px-6 py-4 text-xs text-slate-500 max-w-[220px]">{template.aliases.join('、') || '无'}</td><td className="px-6 py-4 text-sm text-slate-600 max-w-[260px] truncate">{template.subject}</td><td className="px-6 py-4"><span className={cn('px-2 py-1 rounded-full text-xs font-bold', template.enabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500')}>{template.enabled ? '启用' : '停用'}</span></td><td className="px-6 py-4 text-right"><div className="flex justify-end gap-3"><button onClick={() => openEmailTemplateModal(template.id)} className="text-indigo-500 font-bold text-xs">编辑</button><button onClick={() => requestConfirm(`确定删除“${template.name}”吗？`, () => void handleDeleteEmailTemplate(template.id))} className="text-rose-500 font-bold text-xs">删除</button></div></td></tr>)}{emailTemplates.length === 0 && <tr><td colSpan={6} className="px-6 py-10 text-center text-sm text-slate-400">暂无邮件模板</td></tr>}</tbody></table></div>
                    </div>
                  </>
                )}
              </motion.div>
            ) : activeTab === 'settings' ? (
              <motion.div
                key="settings"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="space-y-8 max-w-4xl"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">通用设置</h1>
                    <p className="text-slate-500 mt-1 text-sm">管理桌面客服系统的全局业务开关。</p>
                  </div>
                </div>
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="px-8 py-6 border-b border-slate-100">
                    <h2 className="text-lg font-bold text-slate-900">自动回复</h2>
                    <p className="text-xs text-slate-500 mt-1">总开关关闭时，RPA 仍会采集消息入库，但不会触发机器人自动回复。</p>
                  </div>
                  {isLoadingSettings ? (
                    <div className="py-16 text-center text-sm text-slate-500">正在加载通用设置...</div>
                  ) : (
                    <div className="p-8 space-y-6">
                      <label className="flex items-start justify-between gap-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
                        <span>
                          <span className="block text-sm font-bold text-slate-900">启用自动回复总开关</span>
                          <span className="mt-1 block text-xs leading-5 text-slate-500">
                            开启后，客户消息入站会进入自动回复链路；是否真实发送仍取决于匹配机器人自身的“启用 AI 自动回复”配置。
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={userSettings.auto_reply_enabled}
                          onChange={(event) => updateUserSettings('auto_reply_enabled', event.target.checked)}
                          className="mt-1 h-5 w-5 shrink-0 accent-indigo-600"
                        />
                      </label>
                      {settingsNotice && <div className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-700">{settingsNotice}</div>}
                      <div className="flex justify-end">
                        <button
                          onClick={() => void handleSaveUserSettings()}
                          disabled={isSavingSettings}
                          className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {isSavingSettings ? '保存中...' : '保存设置'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            ) : activeTab === 'api' ? (
              <motion.div
                key="api"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="space-y-8 max-w-5xl"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h1 className="text-2xl font-bold text-slate-900 tracking-tight">AI 模型配置</h1>
                    <p className="text-slate-500 mt-1 text-sm">配置 AI 服务商和模型，用于生成客服回复。</p>
                  </div>
                </div>
                <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm max-w-3xl">
                  {isLoadingAiConfig ? (
                    <div className="py-12 text-center text-sm text-slate-500">正在加载配置...</div>
                  ) : (
                    <div className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <label className="space-y-2">
                          <span className="text-sm font-bold text-slate-700">AI 服务商</span>
                          <select value={aiConfig.provider} onChange={(event) => updateAiConfig('provider', event.target.value as 'deepseek')} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm bg-slate-50" disabled>
                            <option value="deepseek">DeepSeek</option>
                          </select>
                        </label>
                        <label className="space-y-2">
                          <span className="text-sm font-bold text-slate-700">模型</span>
                          <select value={aiConfig.model} onChange={(event) => updateAiConfig('model', event.target.value as 'deepseek-chat' | 'deepseek-reasoner')} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm bg-white">
                            <option value="deepseek-chat">deepseek-chat</option>
                            <option value="deepseek-reasoner">deepseek-reasoner</option>
                          </select>
                        </label>
                      </div>
                      <label className="space-y-2 block">
                        <span className="text-sm font-bold text-slate-700">API Key</span>
                        <input type="password" value={aiConfig.api_key} onChange={(event) => updateAiConfig('api_key', event.target.value)} placeholder={aiConfigMaskedKey ? `已配置：${aiConfigMaskedKey}，留空保持不变` : '请输入 DeepSeek API Key'} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" autoComplete="off" />
                      </label>
                      <label className="space-y-2 block">
                        <span className="text-sm font-bold text-slate-700">Base URL</span>
                        <input value={aiConfig.base_url} onChange={(event) => updateAiConfig('base_url', event.target.value)} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" />
                      </label>
                      {aiConfigNotice && <div className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-700">{aiConfigNotice}</div>}
                      <div className="flex items-center justify-end gap-3 pt-2">
                        <button onClick={handleTestAiConfig} disabled={isTestingAiConfig || (!aiConfig.api_key && !aiConfigMaskedKey)} className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50">{isTestingAiConfig ? '测试中...' : '测试连接'}</button>
                        <button onClick={handleSaveAiConfig} disabled={isSavingAiConfig} className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 disabled:opacity-50">{isSavingAiConfig ? '保存中...' : '保存配置'}</button>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center justify-center py-20 text-center"
              >
                <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-6">
                  <Settings className="w-10 h-10 text-slate-300" />
                </div>
                <h2 className="text-2xl font-bold text-slate-900 mb-2">
                  {currentSubNav?.label ?? currentNav?.label} 模块开发中
                </h2>
                <p className="text-slate-500 max-w-md mx-auto">
                  该功能模块正在接入中，目前仅开放“数据看板”演示。您可以继续查看看板页面的详细指标。
                </p>
                <button 
                  onClick={() => setActiveTab('dashboard')}
                  className="mt-8 px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-colors"
                >
                  返回看板
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Modal Overlay */}
      <AnimatePresence>
        {isFullReportModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 z-[60] flex items-center justify-center p-4 backdrop-blur-sm"
            role="presentation"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden"
              role="dialog"
              aria-modal="true"
              aria-labelledby="full-report-dialog-title"
            >
              <div className="flex items-start gap-4 px-6 py-6">
                <div className="w-11 h-11 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                  <TrendingUp className="w-5 h-5" />
                </div>
                <div>
                  <h3 id="full-report-dialog-title" className="text-lg font-bold text-slate-900">完整数据报告</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">完整报告功能正在开发中，后续将支持按平台、店铺、机器人和时间维度查看详细统计。</p>
                </div>
              </div>
              <div className="flex items-center justify-end px-6 py-4 bg-slate-50 border-t border-slate-100">
                <button onClick={() => setIsFullReportModalOpen(false)} className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700">我知道了</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {selectedProductDocument && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/50 z-[70] flex items-center justify-center p-4 lg:p-6 backdrop-blur-sm"
            role="presentation"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.97, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 10 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl h-[calc(100vh-2rem)] lg:h-[calc(100vh-3rem)] max-h-[900px] overflow-hidden flex flex-col"
              role="dialog"
              aria-modal="true"
              aria-labelledby="product-document-dialog-title"
            >
              <div className="shrink-0 flex items-start justify-between gap-6 px-6 py-5 border-b border-slate-100">
                <div className="min-w-0 flex items-start gap-4">
                  <div className="w-11 h-11 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0"><FileText className="w-5 h-5" /></div>
                  <div className="min-w-0">
                    <h3 id="product-document-dialog-title" className="text-lg font-bold text-slate-900 truncate">{selectedProductDocument.name}</h3>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                      <span>{selectedProductDocument.format}</span>
                      <span>{selectedProductDocument.size}</span>
                      <span>{selectedProductDocument.chunkCount} 个切片</span>
                      <span>更新于 {selectedProductDocument.date}</span>
                      <span className="inline-flex items-center gap-1 font-bold text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" />{selectedProductDocument.status}</span>
                    </div>
                  </div>
                </div>
                <button type="button" onClick={closeProductDocumentModal} className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors" title="关闭"><X className="w-5 h-5" /></button>
              </div>

              <div className="shrink-0 flex flex-col gap-4 px-6 py-4 border-b border-slate-100 bg-slate-50/70 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-center p-1 bg-slate-200/70 rounded-xl self-start">
                  <button type="button" onClick={() => setProductDocumentTab('chunks')} className={cn("px-4 py-2 rounded-lg text-sm font-bold transition-colors", productDocumentTab === 'chunks' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700")}>检索切片 ({productDocumentChunks.length})</button>
                  <button type="button" onClick={() => setProductDocumentTab('content')} className={cn("px-4 py-2 rounded-lg text-sm font-bold transition-colors", productDocumentTab === 'content' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700")}>解析全文</button>
                </div>
                <div className="flex items-center gap-3">
                  <label className="relative flex-1 lg:w-72">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input value={productDocumentSearch} onChange={(event) => setProductDocumentSearch(event.target.value)} placeholder="搜索处理后的内容" className="w-full rounded-xl border border-slate-200 bg-white pl-9 pr-9 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
                    {productDocumentSearch && <button type="button" onClick={() => setProductDocumentSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>}
                  </label>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(productDocumentTab === 'content' ? (productDocumentDetail?.content ?? '') : visibleProductDocumentChunks.map((chunk) => chunk.content).join('\n\n'))} disabled={!productDocumentDetail} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-600 hover:text-indigo-600 disabled:opacity-50"><Copy className="w-4 h-4" />复制</button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-6 bg-slate-50 custom-scrollbar">
                {isLoadingProductDocumentDetail && <div className="h-full min-h-64 flex flex-col items-center justify-center text-sm text-slate-500"><RefreshCw className="w-6 h-6 mb-3 text-indigo-500 animate-spin" />正在读取文档处理结果...</div>}
                {!isLoadingProductDocumentDetail && productDocumentDetailNotice && <div className="max-w-xl mx-auto mt-16 rounded-xl border border-rose-100 bg-rose-50 px-5 py-4 text-sm text-rose-600">{productDocumentDetailNotice}</div>}
                {!isLoadingProductDocumentDetail && productDocumentDetail && productDocumentTab === 'chunks' && (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-700">以下是机器人检索时实际使用的内容。为保证上下文连续，前后切片可能包含少量重复文本。</div>
                    {normalizedProductDocumentSearch && <p className="text-xs text-slate-500">找到 {visibleProductDocumentChunks.length} 个匹配切片</p>}
                    {visibleProductDocumentChunks.map((chunk) => (
                      <article key={chunk.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-3"><span className="rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-600">切片 {chunk.chunk_index + 1} / {productDocumentChunks.length}</span>{chunk.title_path && <span className="text-sm font-bold text-slate-700">{chunk.title_path}</span>}</div>
                          <span className="text-xs text-slate-400">{chunk.content.length} 字符</span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">{chunk.content}</p>
                      </article>
                    ))}
                    {visibleProductDocumentChunks.length === 0 && <div className="py-20 text-center text-sm text-slate-400">没有匹配的切片</div>}
                  </div>
                )}
                {!isLoadingProductDocumentDetail && productDocumentDetail && productDocumentTab === 'content' && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                    <div className="mb-5 flex items-center justify-between gap-4 border-b border-slate-100 pb-4"><div><h4 className="font-bold text-slate-900">解析后的完整文本</h4><p className="mt-1 text-xs text-slate-400">共 {productDocumentDetail.content.length} 个字符，不代表原文件排版</p></div>{normalizedProductDocumentSearch && <span className={cn("text-xs font-bold", productDocumentDetail.content.toLocaleLowerCase().includes(normalizedProductDocumentSearch) ? "text-emerald-600" : "text-slate-400")}>{productDocumentDetail.content.toLocaleLowerCase().includes(normalizedProductDocumentSearch) ? '全文中已找到匹配内容' : '全文中无匹配内容'}</span>}</div>
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-slate-700">{productDocumentDetail.content}</pre>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}

        {emailTemplateModalId !== undefined && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }} className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100"><h3 className="text-lg font-bold text-slate-900">{emailTemplateModalId ? '编辑邮件模板' : '新增邮件模板'}</h3><button onClick={() => setEmailTemplateModalId(undefined)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button></div>
              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="space-y-2"><span className="text-sm font-bold text-slate-700">模板名称</span><input value={emailTemplateForm.name} onChange={(event) => setEmailTemplateForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="例如：店铺看图地址" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" /></label>
                  <label className="space-y-2"><span className="text-sm font-bold text-slate-700">模板 ID</span><input value={emailTemplateForm.template_key} onChange={(event) => setEmailTemplateForm((prev) => ({ ...prev, template_key: event.target.value }))} placeholder="store-view-link" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-mono" /></label>
                  <label className="space-y-2"><span className="text-sm font-bold text-slate-700">业务场景</span><input value={emailTemplateForm.scene} onChange={(event) => setEmailTemplateForm((prev) => ({ ...prev, scene: event.target.value }))} placeholder="store_view_link" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" /></label>
                  <label className="space-y-2"><span className="text-sm font-bold text-slate-700">识别别名</span><input value={emailTemplateForm.aliases.join('、')} onChange={(event) => setEmailTemplateForm((prev) => ({ ...prev, aliases: event.target.value.split(/[、,，\n]/).map((value) => value.trim()).filter(Boolean) }))} placeholder="看图地址、店铺链接" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" /></label>
                </div>
                <label className="space-y-2 block"><span className="text-sm font-bold text-slate-700">邮件主题</span><input value={emailTemplateForm.subject} onChange={(event) => setEmailTemplateForm((prev) => ({ ...prev, subject: event.target.value }))} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" /></label>
                <label className="space-y-2 block"><span className="text-sm font-bold text-slate-700">邮件正文</span><textarea value={emailTemplateForm.body} onChange={(event) => setEmailTemplateForm((prev) => ({ ...prev, body: event.target.value }))} className="w-full h-48 rounded-xl border border-slate-200 p-4 text-sm resize-none" /></label>
                <label className="flex items-center gap-3 text-sm font-bold text-slate-700"><input type="checkbox" checked={emailTemplateForm.enabled} onChange={(event) => setEmailTemplateForm((prev) => ({ ...prev, enabled: event.target.checked }))} className="w-4 h-4 accent-indigo-600" />启用模板</label>
              </div>
              <div className="flex items-center justify-end gap-3 px-6 py-4 bg-slate-50 border-t border-slate-100"><button onClick={() => setEmailTemplateModalId(undefined)} className="px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-bold">取消</button><button onClick={() => void submitEmailTemplate()} disabled={isSavingEmail || !emailTemplateForm.name || !emailTemplateForm.template_key || !emailTemplateForm.subject || !emailTemplateForm.body} className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold disabled:opacity-50">{isSavingEmail ? '保存中...' : '保存模板'}</button></div>
            </motion.div>
          </motion.div>
        )}

        {isAddQABaseModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                <h3 className="text-lg font-bold text-slate-900">新增知识库</h3>
                <button onClick={() => setIsAddQABaseModalOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">问答库名称</label>
                  <input 
                    type="text" 
                    placeholder="例如：官方旗舰店专属问答库" 
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                    value={newQABaseForm.name}
                    onChange={(e) => setNewQABaseForm({ ...newQABaseForm, name: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3 px-6 py-4 bg-slate-50 border-t border-slate-100">
                <button onClick={() => setIsAddQABaseModalOpen(false)} className="flex-1 py-2 lg:py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors">取消</button>
                <button onClick={handleAddQABase} disabled={isSavingQA || !newQABaseForm.name} className="flex-1 py-2 lg:py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{isSavingQA ? '保存中...' : '确认新增'}</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isAddQAItemModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                <h3 className="text-lg font-bold text-slate-900">{editingQAItemId ? '编辑问答' : '添加问答'}</h3>
                <button onClick={() => { setIsAddQAItemModalOpen(false); setEditingQAItemId(null); setShowQaCategoryCreator(false); }} className="text-slate-400 hover:text-slate-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
                {qaNotice && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{qaNotice}</div>}
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">分类</label>
                  <div className="flex items-center gap-2">
                    <select
                      aria-label="问答分类"
                      className="min-w-0 flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      value={qaItemForm.categoryId}
                      onChange={(event) => {
                        const category = qaCategories.find((item) => item.id === event.target.value);
                        setQaItemForm({ ...qaItemForm, categoryId: category?.id ?? '', category: category?.name ?? '' });
                      }}
                    >
                      {!qaItemForm.categoryId && <option value="">未分类</option>}
                      {qaCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={() => setShowQaCategoryCreator((current) => !current)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-bold text-indigo-600 hover:bg-indigo-50"
                    >
                      <Plus className="h-4 w-4" />
                      新增分类
                    </button>
                  </div>
                  {showQaCategoryCreator && (
                    <div className="flex items-center gap-2 rounded-xl border border-indigo-100 bg-indigo-50 p-3">
                      <input
                        type="text"
                        aria-label="自定义分类名称"
                        placeholder="输入自定义分类名称"
                        value={newQaCategoryName}
                        onChange={(event) => setNewQaCategoryName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void handleCreateQaCategory();
                          }
                        }}
                        className="min-w-0 flex-1 rounded-lg border border-indigo-100 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <button
                        type="button"
                        onClick={() => void handleCreateQaCategory()}
                        disabled={isCreatingQaCategory || !newQaCategoryName.trim()}
                        className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {isCreatingQaCategory ? '添加中...' : '添加'}
                      </button>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">问题</label>
                  <input 
                    type="text" 
                    placeholder="输入客户可能提出的问题" 
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                    value={qaItemForm.question}
                    onChange={(e) => setQaItemForm({ ...qaItemForm, question: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">关键词</label>
                  <textarea 
                    placeholder="每行一个，或者用逗号分隔" 
                    className="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none"
                    value={qaItemForm.keywords}
                    onChange={(e) => setQaItemForm({ ...qaItemForm, keywords: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">答案</label>
                  <textarea 
                    placeholder="输入机器人要返回的答案..." 
                    className="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none"
                    value={qaItemForm.answer}
                    onChange={(e) => setQaItemForm({ ...qaItemForm, answer: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">图片</label>
                  <label className="flex items-center gap-3 px-4 py-3 bg-slate-50 border border-dashed border-slate-300 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                    <ImageIcon className="w-5 h-5 text-slate-400" />
                    <span className="text-sm text-slate-600 truncate">{qaItemForm.image?.name ?? '上传图片（可选）'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => setQaItemForm({ ...qaItemForm, image: e.target.files?.[0] ?? null })}
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700">权重 (数字越大越靠前)</label>
                    <input 
                      type="number" 
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      value={qaItemForm.weight}
                      onChange={(e) => setQaItemForm({ ...qaItemForm, weight: Number(e.target.value) })}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-700 mb-2 block">状态</label>
                    <div className="flex items-center h-[46px] px-2">
                      <div 
                        onClick={() => setQaItemForm({ ...qaItemForm, enabled: !qaItemForm.enabled })}
                        className={`w-12 h-6 rounded-full relative cursor-pointer shadow-inner transition-colors ${qaItemForm.enabled ? 'bg-indigo-500' : 'bg-slate-300'}`}
                      >
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm ${qaItemForm.enabled ? 'right-1' : 'left-1'}`}></div>
                      </div>
                      <span className="ml-3 text-sm font-medium text-slate-600">{qaItemForm.enabled ? '已启用' : '已禁用'}</span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 px-6 py-4 bg-slate-50 border-t border-slate-100">
                <button onClick={() => { setIsAddQAItemModalOpen(false); setEditingQAItemId(null); setShowQaCategoryCreator(false); }} className="flex-1 py-2 lg:py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors">取消</button>
                <button onClick={handleAddQAItem} disabled={isSavingQA || !qaItemForm.question || !qaItemForm.answer} className="flex-1 py-2 lg:py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{isSavingQA ? '保存中...' : '保存'}</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isAddToneKBModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                <h3 className="text-lg font-bold text-slate-900">{editingToneKBId ? '编辑语气知识库' : '新增语气知识库'}</h3>
                <button onClick={() => { setIsAddToneKBModalOpen(false); setEditingToneKBId(null); }} className="text-slate-400 hover:text-slate-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6">
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">知识库名称</label>
                  <input
                    type="text"
                    placeholder="例如：亲切友好语气库"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                    value={newToneKBForm.name}
                    onChange={(event) => setNewToneKBForm({ ...newToneKBForm, name: event.target.value })}
                  />
                </div>
                <div className="space-y-2 mt-4">
                  <label className="text-sm font-bold text-slate-700">虚拟人设</label>
                  <textarea
                    placeholder="例如：专业耐心的资深客服，使用清晰、友好的表达方式"
                    className="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none"
                    value={newToneKBForm.persona}
                    onChange={(event) => setNewToneKBForm({ ...newToneKBForm, persona: event.target.value })}
                  />
                </div>
                {toneKBNotice && <p className="mt-4 text-sm text-rose-500">{toneKBNotice}</p>}
              </div>
              <div className="flex items-center gap-3 px-6 py-4 bg-slate-50 border-t border-slate-100">
                <button onClick={() => { setIsAddToneKBModalOpen(false); setEditingToneKBId(null); }} className="flex-1 py-2 lg:py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors">取消</button>
                <button onClick={handleSaveToneKB} disabled={isSavingToneKB || !newToneKBForm.name.trim() || !newToneKBForm.persona.trim()} className="flex-1 py-2 lg:py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{isSavingToneKB ? '保存中...' : '保存'}</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {isAddProductKBModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                <h3 className="text-lg font-bold text-slate-900">新增产品知识库</h3>
                <button onClick={() => setIsAddProductKBModalOpen(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-700">知识库名称</label>
                  <input 
                    type="text" 
                    placeholder="例如：主打商品知识库" 
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                    value={newProductKBForm.name}
                    onChange={(e) => setNewProductKBForm({ ...newProductKBForm, name: e.target.value })}
                  />
                </div>
                {productKBNotice && <p className="text-sm text-rose-500">{productKBNotice}</p>}
              </div>
              <div className="flex items-center gap-3 px-6 py-4 bg-slate-50 border-t border-slate-100">
                <button onClick={() => setIsAddProductKBModalOpen(false)} className="flex-1 py-2 lg:py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors">取消</button>
                <button onClick={() => void handleAddProductKB()} disabled={isSavingProductKB || !newProductKBForm.name.trim()} className="flex-1 py-2 lg:py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{isSavingProductKB ? '创建中...' : '确认'}</button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {testReplyRobotId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-2xl shadow-xl w-full max-w-3xl h-[calc(100vh-2rem)] max-h-[800px] overflow-hidden flex flex-col"
            >
              <div className="flex shrink-0 items-center justify-between px-6 py-4 border-b border-slate-100">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">测试回复</h3>
                  <p className="text-xs text-slate-500 mt-1">{robots.find((robot) => robot.id === testReplyRobotId)?.name}</p>
                </div>
                <button onClick={() => setTestReplyRobotId(null)} className="text-slate-400 hover:text-slate-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4 custom-scrollbar">
                <div className="h-80 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50 p-4 space-y-3 custom-scrollbar">
                  {testReplyMessages.length === 0 && <p className="py-20 text-center text-sm text-slate-400">输入问题开始多轮测试</p>}
                  {testReplyMessages.map((item, index) => (
                    <div key={`${index}-${item.role}`} className={cn('flex', item.role === 'user' ? 'justify-end' : 'justify-start')}>
                      <div className={cn('max-w-[82%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap', item.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-700')}>
                        {item.content}
                        {item.media?.map((media) => media.type === 'image' && media.url ? <ImagePreview key={media.url} src={media.url} alt="问答图片" className="mt-2" /> : null)}
                      </div>
                    </div>
                  ))}
                </div>
                <textarea value={testReplyText} onChange={(event) => setTestReplyText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void handleTestReply(); } }} placeholder="输入客户问题，Enter 发送，Shift+Enter 换行" className="w-full h-20 p-4 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-500 outline-none transition-all resize-none" />
                {testReplyDebug && (
                  <details className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
                    <summary className="cursor-pointer font-bold text-slate-700">查看本轮决策链路</summary>
                    <div className="mt-3 max-h-72 overflow-y-auto pr-1 custom-scrollbar">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-lg bg-slate-50 p-3">
                          <p className="font-bold text-slate-500">意图</p>
                          <p className="mt-1 break-all text-slate-800">{String(testReplyDebug.intent.intent || 'unknown')} · {Math.round(testReplyDebug.confidence * 100)}%</p>
                        </div>
                        <div className="rounded-lg bg-slate-50 p-3">
                          <p className="font-bold text-slate-500">下一动作</p>
                          <p className="mt-1 break-all text-slate-800">{String(testReplyDebug.action_plan.next_action || '未定义')}</p>
                        </div>
                        <div className="rounded-lg bg-slate-50 p-3">
                          <p className="font-bold text-slate-500">模型调用</p>
                          <p className="mt-1 break-all text-slate-800">意图：{testReplyDebug.model_calls.intent || 'skipped'}；生成：{testReplyDebug.model_calls.generation || 'skipped'}</p>
                        </div>
                        <div className="rounded-lg bg-slate-50 p-3">
                          <p className="font-bold text-slate-500">知识检索</p>
                          <p className="mt-1 text-slate-800">召回 {testReplyDebug.retrieval.length} 个片段</p>
                        </div>
                      </div>
                      {testReplyDebug.retrieval.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {testReplyDebug.retrieval.slice(0, 3).map((item, index) => (
                            <div key={`${testReplyDebug.trace_id}-${index}`} className="rounded-lg bg-indigo-50 px-3 py-2 text-indigo-900">
                              {String(item.snippet || item.content || '无摘要')}
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="mt-3 font-mono text-[11px] text-slate-400">Trace ID: {testReplyDebug.trace_id}</p>
                    </div>
                  </details>
                )}
                {testReplyResult && <div className="p-3 bg-rose-50 border border-rose-100 rounded-xl text-sm text-rose-700">{testReplyResult}</div>}
              </div>
              <div className="flex shrink-0 items-center justify-end gap-3 px-6 py-4 bg-slate-50 border-t border-slate-100">
                <button onClick={() => { setTestReplyRobotId(null); setTestReplyMessages([]); setTestReplyResult(''); setTestReplyDebug(null); }} className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors">关闭</button>
                <button
                  onClick={() => void handleTestReply()}
                  disabled={isTestingReply || !testReplyText.trim()}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 transition-colors"
                >
                  {isTestingReply ? '生成中...' : '发送测试消息'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {confirmDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/40 z-[60] flex items-center justify-center p-4 backdrop-blur-sm"
            role="presentation"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-dialog-title"
            >
              <div className="px-6 py-5">
                <h3 id="confirm-dialog-title" className="text-lg font-bold text-slate-900">确认删除</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{confirmDialog.message}</p>
              </div>
              <div className="flex items-center justify-end gap-3 px-6 py-4 bg-slate-50 border-t border-slate-100">
                <button onClick={() => setConfirmDialog(null)} className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors">取消</button>
                <button
                  onClick={() => {
                    const action = confirmDialog.onConfirm;
                    setConfirmDialog(null);
                    action();
                  }}
                  className="px-4 py-2 bg-rose-600 text-white rounded-xl text-sm font-bold hover:bg-rose-700 transition-colors"
                >
                  确认删除
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #E2E8F0;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #CBD5E1;
        }
      `}</style>
    </div>
  );
}

function StatIcon({ title, className }: { title: string, className?: string }) {
  if (title.includes('消息')) return <MessageSquare className={cn("w-5 h-5", className)} />;
  if (title.includes('访问')) return <Users className={cn("w-5 h-5", className)} />;
  if (title.includes('消耗')) return <Zap className={cn("w-5 h-5", className)} />;
  if (title.includes('充值')) return <DollarSign className={cn("w-5 h-5", className)} />;
  if (title.includes('恢复')) return <Zap className={cn("w-5 h-5", className)} />;
  if (title.includes('接待')) return <Bot className={cn("w-5 h-5", className)} />;
  if (title.includes('响应')) return <Clock className={cn("w-5 h-5", className)} />;
  if (title.includes('订单')) return <ShoppingBag className={cn("w-5 h-5", className)} />;
  if (title.includes('满意')) return <ThumbsUp className={cn("w-5 h-5", className)} />;
  if (title.includes('客服') || title.includes('人工')) return <User className={cn("w-5 h-5", className)} />;
  if (title.includes('机器人')) return <Headset className={cn("w-5 h-5", className)} />;
  return <TrendingUp className={cn("w-5 h-5", className)} />;
}

function getIconBgColor(title: string) {
  if (title.includes('消息') || title.includes('访问')) return 'bg-blue-50';
  if (title.includes('消耗')) return 'bg-orange-50';
  if (title.includes('充值')) return 'bg-emerald-50';
  if (title.includes('有效') || title.includes('接待')) return 'bg-indigo-50';
  if (title.includes('转化') || title.includes('满意')) return 'bg-violet-50';
  return 'bg-slate-50';
}

function getIconTextColor(title: string) {
  if (title.includes('消息') || title.includes('访问')) return 'text-blue-500';
  if (title.includes('消耗')) return 'text-orange-500';
  if (title.includes('充值')) return 'text-emerald-500';
  if (title.includes('有效') || title.includes('接待')) return 'text-indigo-500';
  if (title.includes('转化') || title.includes('满意')) return 'text-violet-500';
  return 'text-slate-500';
}
