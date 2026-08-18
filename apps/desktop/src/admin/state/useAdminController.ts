import { useEffect, useRef, useState } from 'react';
import {
  createRobot,
  createKnowledgeBase,
  createQaCategory,
  createQaEntry,
  deleteQaEntry,
  deleteRobot,
  deleteUnusedKnowledgeBase,
  deleteKnowledgeDocument,
  deleteEmailTemplate,
  getEmailConfig,
  getKnowledgeBaseUsage,
  getUserSettings,
  getKnowledgeBase,
  getKnowledgeDocument,
  importProductDocument,
  listPlatformAccounts,
  listKnowledgeBases,
  listQaCategories,
  listQaEntries,
  listProductDocuments,
  listKnowledgeDocumentChunks,
  reprocessKnowledgeDocument,
  listRobots,
  listEmailTemplates,
  saveEmailConfig,
  saveUserSettings,
  listAiModels,
  syncAiModels,
  testRobotReply,
  testEmailConfig,
  updateRobot,
  updateEmailTemplate,
  updateKnowledgeBase,
  updateQaEntry,
  uploadQaImage,
  createEmailTemplate,
  type ApiRobot,
  type AiModel,
  type EmailConfigInput,
  type EmailTemplate,
  type EmailTemplateInput,
  type UserSettingsInput,
  type KnowledgeDocument,
  type KnowledgeDocumentChunk,
  type KnowledgeDocumentDetail,
  type KnowledgeBaseSummary,
  type PlatformAccount,
  type QaCategory,
  type QaEntry,
  type RobotInput,
  type TestReplyMessage,
  type TestReplyResult,
} from '../../shared/api/client';

type QABase = { id: string; name: string; count: number; date: string; isPublic: boolean; isOwner: boolean; ownerName: string };
type QABaseForm = { name: string; isPublic: boolean };
type QAItem = {
  id: string;
  baseId: string;
  categoryId: string;
  category: string;
  question: string;
  keywords: string;
  answer: string;
  image: File | null;
  imageUrl: string;
  weight: number;
  calls: number;
  enabled: boolean;
};
type QAItemForm = Omit<QAItem, 'id' | 'baseId' | 'calls'>;

function mapQABase(base: KnowledgeBaseSummary): QABase {
  return { id: base.id, name: base.name, count: base.item_count, date: base.updated_at.slice(0, 10), isPublic: base.is_public, isOwner: base.is_owner, ownerName: base.owner_display_name };
}

function mapQAItem(entry: QaEntry): QAItem {
  return {
    id: entry.id,
    baseId: entry.base_id,
    categoryId: entry.category_id,
    category: entry.category,
    question: entry.question,
    keywords: entry.keywords.join('、'),
    answer: entry.answer,
    image: null,
    imageUrl: entry.image_url,
    weight: entry.weight,
    calls: entry.call_count,
    enabled: entry.enabled,
  };
}
type RoutingCard = { id: number; start: string; end: string; ratio: number };
type ProductKB = { id: string; name: string; count: number; status: string; date: string; isPublic: boolean; isOwner: boolean; ownerName: string };

function mapProductBase(base: KnowledgeBaseSummary): ProductKB {
  return {
    id: base.id,
    name: base.name,
    count: base.item_count,
    status: base.enabled ? '已同步' : '已停用',
    date: base.updated_at.slice(0, 10),
    isPublic: base.is_public,
    isOwner: base.is_owner,
    ownerName: base.owner_display_name,
  };
}
type ProductDocument = {
  id: string;
  name: string;
  size: string;
  format: string;
  status: string;
  date: string;
  chunkCount: number;
  chunkStrategyVersion: string;
};
type ToneKB = { id: string; name: string; persona: string; date: string; isPublic: boolean; isOwner: boolean; ownerName: string };

function mapToneBase(base: KnowledgeBaseSummary): ToneKB {
  return { id: base.id, name: base.name, persona: base.persona, date: base.updated_at.slice(0, 10), isPublic: base.is_public, isOwner: base.is_owner, ownerName: base.owner_display_name };
}
export type AdminRobot = {
  id: string;
  name: string;
  model: string;
  knowledgeBases: string[];
  strategies: string[];
  shops: string[];
  platformShops: string[];
  status: 'online' | 'offline';
  lastUpdated: string;
  api: ApiRobot;
};

function mapRobot(
  robot: ApiRobot,
  accounts: PlatformAccount[] = [],
  knowledgeBases: KnowledgeBaseSummary[] = [],
): AdminRobot {
  const accountNames = new Map(accounts.map((account) => [account.id, account.account_alias || account.account_name]));
  const knowledgeBaseNames = new Map(knowledgeBases.map((base) => [base.id, base.name]));
  const scopes = robot.platform_scopes.map((scope) => {
    const platform = scope.platform_code;
    const account = scope.platform_account_id ? accountNames.get(scope.platform_account_id) : null;
    return `${platform} · ${scope.all_accounts ? '全部店铺' : account || scope.platform_account_id || '未指定店铺'}`;
  });
  const config = robot.config_json || {};
  const model = typeof config.model === 'string' && config.model ? config.model : 'deepseek-v4-flash';
  return {
    id: robot.id,
    name: robot.name,
    model,
    knowledgeBases: [...robot.qa_knowledge_base_ids, ...robot.product_knowledge_base_ids]
      .map((id) => knowledgeBaseNames.get(id) || id),
    strategies: robot.tone_knowledge_base_id
      ? [knowledgeBaseNames.get(robot.tone_knowledge_base_id) || robot.tone_knowledge_base_id]
      : [],
    shops: scopes,
    platformShops: scopes,
    status: robot.status,
    lastUpdated: robot.updated_at.slice(0, 10),
    api: robot,
  };
}

export function useAdminController() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [robots, setRobots] = useState<AdminRobot[]>([]);
  const [platformAccounts, setPlatformAccounts] = useState<PlatformAccount[]>([]);
  const [robotKnowledgeBases, setRobotKnowledgeBases] = useState<KnowledgeBaseSummary[]>([]);
  const [selectedRobotId, setSelectedRobotId] = useState<string | null>(null);
  const [isLoadingRobots, setIsLoadingRobots] = useState(false);
  const [isSavingRobot, setIsSavingRobot] = useState(false);
  const [robotNotice, setRobotNotice] = useState('');
  const [selectedQABase, setSelectedQABase] = useState<QABase | null>(null);
  const [isAddQABaseModalOpen, setIsAddQABaseModalOpen] = useState(false);
  const [newQABaseForm, setNewQABaseForm] = useState<QABaseForm>({ name: '', isPublic: false });
  const [isAddQAItemModalOpen, setIsAddQAItemModalOpen] = useState(false);
  const [editingQAItemId, setEditingQAItemId] = useState<string | null>(null);
  const [qaItemForm, setQaItemForm] = useState<QAItemForm>({
    categoryId: '',
    category: '',
    question: '',
    keywords: '',
    answer: '',
    image: null,
    imageUrl: '',
    weight: 10,
    enabled: true,
  });
  const [qaBases, setQaBases] = useState<QABase[]>([]);
  const [qaItems, setQaItems] = useState<QAItem[]>([]);
  const [qaCategories, setQaCategories] = useState<QaCategory[]>([]);
  const [qaCategoryFilter, setQaCategoryFilter] = useState('all');
  const [qaKeyword, setQaKeyword] = useState('');
  const [qaKeywordDraft, setQaKeywordDraft] = useState('');
  const [qaPage, setQaPage] = useState(1);
  const [qaPageCount, setQaPageCount] = useState(1);
  const [qaTotal, setQaTotal] = useState(0);
  const [newQaCategoryName, setNewQaCategoryName] = useState('');
  const [isCreatingQaCategory, setIsCreatingQaCategory] = useState(false);
  const [isLoadingQA, setIsLoadingQA] = useState(false);
  const [isSavingQA, setIsSavingQA] = useState(false);
  const [qaNotice, setQaNotice] = useState('');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [expandedMenus, setExpandedMenus] = useState<string[]>(['agent']);
  const [robotSubTab, setRobotSubTab] = useState('base');
  const [routingCards, setRoutingCards] = useState<RoutingCard[]>([{ id: 1, start: '09:00', end: '18:00', ratio: 20 }]);
  const [productBases, setProductBases] = useState<ProductKB[]>([]);
  const [isAddProductKBModalOpen, setIsAddProductKBModalOpen] = useState(false);
  const [newProductKBForm, setNewProductKBForm] = useState({ name: '', isPublic: false });
  const [isLoadingProductKB, setIsLoadingProductKB] = useState(false);
  const [isSavingProductKB, setIsSavingProductKB] = useState(false);
  const [productKBNotice, setProductKBNotice] = useState('');
  const [selectedProductKB, setSelectedProductKB] = useState<ProductKB | null>(null);
  const [productKBName, setProductKBName] = useState('');
  const [productDocuments, setProductDocuments] = useState<Record<string, ProductDocument[]>>({});
  const [selectedProductDocument, setSelectedProductDocument] = useState<ProductDocument | null>(null);
  const [productDocumentDetail, setProductDocumentDetail] = useState<KnowledgeDocumentDetail | null>(null);
  const [productDocumentChunks, setProductDocumentChunks] = useState<KnowledgeDocumentChunk[]>([]);
  const [selectedProductFile, setSelectedProductFile] = useState<File | null>(null);
  const [isImportingProductDocument, setIsImportingProductDocument] = useState(false);
  const [productImportProgress, setProductImportProgress] = useState(0);
  const [productImportNotice, setProductImportNotice] = useState('');
  const [isLoadingProductDocuments, setIsLoadingProductDocuments] = useState(false);
  const [isLoadingProductDocumentDetail, setIsLoadingProductDocumentDetail] = useState(false);
  const [isReprocessingProductDocument, setIsReprocessingProductDocument] = useState(false);
  const [productDocumentDetailNotice, setProductDocumentDetailNotice] = useState('');
  const [toneBases, setToneBases] = useState<ToneKB[]>([]);
  const [isAddToneKBModalOpen, setIsAddToneKBModalOpen] = useState(false);
  const [editingToneKBId, setEditingToneKBId] = useState<string | null>(null);
  const [newToneKBForm, setNewToneKBForm] = useState({ name: '', persona: '', isPublic: false });
  const [isLoadingToneKB, setIsLoadingToneKB] = useState(false);
  const [isSavingToneKB, setIsSavingToneKB] = useState(false);
  const [toneKBNotice, setToneKBNotice] = useState('');
  const [aiModels, setAiModels] = useState<AiModel[]>([]);
  const [isLoadingAiModels, setIsLoadingAiModels] = useState(false);
  const [isSyncingAiModels, setIsSyncingAiModels] = useState(false);
  const [aiConfigNotice, setAiConfigNotice] = useState('');
  const [emailConfig, setEmailConfig] = useState<EmailConfigInput>({
    enabled: false,
    provider: 'qq',
    sender_email: '',
    smtp_host: 'smtp.qq.com',
    smtp_port: 465,
    security: 'ssl',
    auth_code: '',
    trigger_scenarios: '',
    ask_email_text: '',
    success_text: '',
    missing_template_text: '',
  });
  const [emailAuthCodeSaved, setEmailAuthCodeSaved] = useState(false);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [isLoadingEmail, setIsLoadingEmail] = useState(false);
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [isTestingEmail, setIsTestingEmail] = useState(false);
  const [emailNotice, setEmailNotice] = useState('');
  const [userSettings, setUserSettings] = useState<UserSettingsInput>({ auto_reply_enabled: false });
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState('');

  const runTestRobotReply = async (input: {
    robot_id: string;
    message: string;
    conversation: TestReplyMessage[];
    platform_code?: string;
    shop_name?: string;
    customer_name?: string;
  }): Promise<TestReplyResult> => testRobotReply(input);

  const loadRobots = async () => {
    setIsLoadingRobots(true);
    setRobotNotice('');
    try {
      const [items, accounts, knowledgeBases, models] = await Promise.all([
        listRobots(),
        listPlatformAccounts(),
        listKnowledgeBases(),
        listAiModels(),
      ]);
      setPlatformAccounts(accounts.items);
      setRobotKnowledgeBases(knowledgeBases);
      setAiModels(models.items);
      setRobots(items.map((item) => mapRobot(item, accounts.items, knowledgeBases)));
    } catch (error) {
      setRobotNotice(error instanceof Error ? error.message : '无法加载机器人配置');
    } finally {
      setIsLoadingRobots(false);
    }
  };

  useEffect(() => {
    if (activeTab !== 'robot-list' && activeTab !== 'robot-base') return;
    void loadRobots();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'knowledge-qa') return;
    let cancelled = false;
    setIsLoadingQA(true);
    setQaNotice('');
    listKnowledgeBases('qa')
      .then((items) => !cancelled && setQaBases(items.map(mapQABase)))
      .catch((error: Error) => !cancelled && setQaNotice(error.message))
      .finally(() => !cancelled && setIsLoadingQA(false));
    return () => { cancelled = true; };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'knowledge-tone') return;
    let cancelled = false;
    setIsLoadingToneKB(true);
    setToneKBNotice('');
    listKnowledgeBases('tone')
      .then((items) => !cancelled && setToneBases(items.map(mapToneBase)))
      .catch((error: Error) => !cancelled && setToneKBNotice(error.message))
      .finally(() => !cancelled && setIsLoadingToneKB(false));
    return () => { cancelled = true; };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'knowledge-product') return;
    let cancelled = false;
    setIsLoadingProductKB(true);
    setProductKBNotice('');
    listKnowledgeBases('product')
      .then((items) => {
        if (cancelled) return;
        const mapped = items.map(mapProductBase);
        setProductBases(mapped);
        const refreshedSelected = selectedProductKB
          ? mapped.find((base) => base.id === selectedProductKB.id) ?? null
          : null;
        setSelectedProductKB(refreshedSelected);
        if (refreshedSelected) setProductKBName(refreshedSelected.name);
      })
      .catch((error: Error) => !cancelled && setProductKBNotice(error.message))
      .finally(() => !cancelled && setIsLoadingProductKB(false));
    return () => { cancelled = true; };
  }, [activeTab]);

  useEffect(() => {
    if (!selectedQABase) {
      setQaItems([]);
      setQaCategories([]);
      setQaCategoryFilter('all');
      setQaKeyword('');
      setQaKeywordDraft('');
      setQaPage(1);
      setQaPageCount(1);
      setQaTotal(0);
      return;
    }
    let cancelled = false;
    setIsLoadingQA(true);
    setQaNotice('');
    Promise.all([
      listQaEntries(selectedQABase.id, {
        categoryId: qaCategoryFilter,
        keyword: qaKeyword,
        page: qaPage,
      }),
      listQaCategories(selectedQABase.id),
    ])
      .then(([result, categories]) => {
        if (cancelled) return;
        setQaItems(result.items.map(mapQAItem));
        setQaCategories(categories);
        setQaPage(result.page);
        setQaPageCount(result.pages);
        setQaTotal(result.total);
      })
      .catch((error: Error) => !cancelled && setQaNotice(error.message))
      .finally(() => !cancelled && setIsLoadingQA(false));
    return () => { cancelled = true; };
  }, [selectedQABase?.id, qaCategoryFilter, qaKeyword, qaPage]);

  const refreshQaPage = async (page = qaPage) => {
    if (!selectedQABase) return;
    const [result, categories] = await Promise.all([
      listQaEntries(selectedQABase.id, {
        categoryId: qaCategoryFilter,
        keyword: qaKeyword,
        page,
      }),
      listQaCategories(selectedQABase.id),
    ]);
    setQaItems(result.items.map(mapQAItem));
    setQaCategories(categories);
    setQaPage(result.page);
    setQaPageCount(result.pages);
    setQaTotal(result.total);
  };

  useEffect(() => {
    if (activeTab !== 'api') return;
    let cancelled = false;
    setIsLoadingAiModels(true);
    listAiModels()
      .then((result) => {
        if (cancelled) return;
        setAiModels(result.items);
      })
      .catch((error: Error) => !cancelled && setAiConfigNotice(error.message))
      .finally(() => !cancelled && setIsLoadingAiModels(false));
    return () => { cancelled = true; };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'email') return;
    let cancelled = false;
    setIsLoadingEmail(true);
    setEmailNotice('');
    Promise.all([getEmailConfig(), listEmailTemplates(), listPlatformAccounts()])
      .then(([config, templates, accounts]) => {
        if (cancelled) return;
        setEmailConfig({
          enabled: config.enabled,
          provider: config.provider,
          sender_email: config.sender_email,
          smtp_host: config.smtp_host,
          smtp_port: config.smtp_port,
          security: config.security,
          auth_code: '',
          trigger_scenarios: config.trigger_scenarios,
          ask_email_text: config.ask_email_text,
          success_text: config.success_text,
          missing_template_text: config.missing_template_text,
        });
        setEmailAuthCodeSaved(config.auth_code_saved);
        setEmailTemplates(templates);
        setPlatformAccounts(accounts.items);
      })
      .catch((error: Error) => !cancelled && setEmailNotice(error.message))
      .finally(() => !cancelled && setIsLoadingEmail(false));
    return () => { cancelled = true; };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'settings') return;
    let cancelled = false;
    setIsLoadingSettings(true);
    setSettingsNotice('');
    getUserSettings()
      .then((settings) => {
        if (cancelled) return;
        setUserSettings({ auto_reply_enabled: settings.auto_reply_enabled });
      })
      .catch((error: Error) => !cancelled && setSettingsNotice(error.message))
      .finally(() => !cancelled && setIsLoadingSettings(false));
    return () => { cancelled = true; };
  }, [activeTab]);

  const handleSyncAiModels = async () => {
    setIsSyncingAiModels(true);
    setAiConfigNotice('');
    try {
      const result = await syncAiModels();
      setAiModels(result.items);
      setAiConfigNotice(`已获取 ${result.items.filter((item) => item.available).length} 个可用模型`);
    } catch (error) {
      setAiConfigNotice(error instanceof Error ? error.message : '获取模型列表失败');
    } finally {
      setIsSyncingAiModels(false);
    }
  };

  const updateEmailConfig = <K extends keyof EmailConfigInput>(key: K, value: EmailConfigInput[K]) => {
    setEmailConfig((prev) => ({ ...prev, [key]: value }));
    setEmailNotice('');
  };

  const handleSaveEmailConfig = async () => {
    setIsSavingEmail(true);
    setEmailNotice('');
    try {
      const saved = await saveEmailConfig(emailConfig);
      setEmailAuthCodeSaved(saved.auth_code_saved);
      setEmailConfig((prev) => ({ ...prev, auth_code: '' }));
      setEmailNotice('邮件配置已保存');
    } catch (error) {
      setEmailNotice(error instanceof Error ? error.message : '邮件配置保存失败');
    } finally {
      setIsSavingEmail(false);
    }
  };

  const handleTestEmailConfig = async (toEmail: string, templateId?: string) => {
    setIsTestingEmail(true);
    setEmailNotice('');
    try {
      const result = await testEmailConfig(toEmail, templateId);
      setEmailNotice(`${result.message}（${result.elapsed_ms} ms）`);
    } catch (error) {
      setEmailNotice(error instanceof Error ? error.message : '测试邮件发送失败');
    } finally {
      setIsTestingEmail(false);
    }
  };

  const handleSaveEmailTemplate = async (id: string | null, input: EmailTemplateInput) => {
    setIsSavingEmail(true);
    setEmailNotice('');
    try {
      const saved = id ? await updateEmailTemplate(id, input) : await createEmailTemplate(input);
      setEmailTemplates((prev) => prev.some((item) => item.id === saved.id)
        ? prev.map((item) => item.id === saved.id ? saved : item)
        : [saved, ...prev]);
      setEmailNotice('邮件模板已保存');
    } catch (error) {
      setEmailNotice(error instanceof Error ? error.message : '邮件模板保存失败');
      throw error;
    } finally {
      setIsSavingEmail(false);
    }
  };

  const handleDeleteEmailTemplate = async (id: string) => {
    try {
      await deleteEmailTemplate(id);
      setEmailTemplates((prev) => prev.filter((item) => item.id !== id));
      setEmailNotice('邮件模板已删除');
    } catch (error) {
      setEmailNotice(error instanceof Error ? error.message : '邮件模板删除失败');
    }
  };

  const updateUserSettings = <K extends keyof UserSettingsInput>(key: K, value: UserSettingsInput[K]) => {
    setUserSettings((prev) => ({ ...prev, [key]: value }));
    setSettingsNotice('');
  };

  const handleSaveUserSettings = async () => {
    setIsSavingSettings(true);
    setSettingsNotice('');
    try {
      const saved = await saveUserSettings(userSettings);
      setUserSettings({ auto_reply_enabled: saved.auto_reply_enabled });
      setSettingsNotice('通用设置已保存');
    } catch (error) {
      setSettingsNotice(error instanceof Error ? error.message : '通用设置保存失败');
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleAddRoutingCard = () => {
    setRoutingCards((prev) => [...prev, { id: Date.now(), start: '09:00', end: '18:00', ratio: 20 }]);
  };

  const handleDeleteRoutingCard = (id: number) => {
    setRoutingCards((prev) => prev.filter((card) => card.id !== id));
  };

  const handleUpdateRoutingRatio = (id: number, ratio: number) => {
    setRoutingCards((prev) => prev.map((card) => (card.id === id ? { ...card, ratio } : card)));
  };

  const handleAddQABase = async () => {
    const name = newQABaseForm.name.trim();
    if (!name) return;
    setIsSavingQA(true);
    setQaNotice('');
    try {
      const created = await createKnowledgeBase(name, 'qa', '', newQABaseForm.isPublic);
      const newBase = mapQABase(created);
      setQaBases((prev) => [newBase, ...prev]);
      setIsAddQABaseModalOpen(false);
      setSelectedQABase(newBase);
      setNewQABaseForm({ name: '', isPublic: false });
    } catch (error) {
      setQaNotice(error instanceof Error ? error.message : '新增问答库失败');
    } finally {
      setIsSavingQA(false);
    }
  };

  const handleAddQAItem = async () => {
    if (!qaItemForm.question || !selectedQABase) return;
    setIsSavingQA(true);
    setQaNotice('');
    try {
      let imageUrl = qaItemForm.imageUrl;
      if (qaItemForm.image) {
        imageUrl = (await uploadQaImage(qaItemForm.image)).image_url;
      }
      const input = {
        category_id: qaItemForm.categoryId,
        category: qaItemForm.category.trim(),
        question: qaItemForm.question.trim(),
        keywords: qaItemForm.keywords.split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean),
        answer: qaItemForm.answer.trim(),
        image_url: imageUrl,
        weight: qaItemForm.weight,
        enabled: qaItemForm.enabled,
      };
      editingQAItemId
        ? await updateQaEntry(editingQAItemId, input)
        : await createQaEntry(selectedQABase.id, input);
      await refreshQaPage(editingQAItemId ? qaPage : 1);
      const summary = await getKnowledgeBase(selectedQABase.id);
      const updatedBase = mapQABase(summary);
      setQaBases((prev) => prev.map((base) => base.id === updatedBase.id ? updatedBase : base));
      setSelectedQABase(updatedBase);
      setIsAddQAItemModalOpen(false);
      setEditingQAItemId(null);
      setQaItemForm({ categoryId: '', category: '', question: '', keywords: '', answer: '', image: null, imageUrl: '', weight: 10, enabled: true });
    } catch (error) {
      setQaNotice(error instanceof Error ? error.message : '保存问答失败');
    } finally {
      setIsSavingQA(false);
    }
  };

  const openAddQAItem = () => {
    setEditingQAItemId(null);
    const defaultCategory = qaCategories.find((category) => category.name === '常见问题') ?? qaCategories[0];
    setQaItemForm({ categoryId: defaultCategory?.id ?? '', category: defaultCategory?.name ?? '', question: '', keywords: '', answer: '', image: null, imageUrl: '', weight: 10, enabled: true });
    setNewQaCategoryName('');
    setIsAddQAItemModalOpen(true);
  };

  const openEditQAItem = (id: string) => {
    const item = qaItems.find((candidate) => candidate.id === id);
    if (!item) return;
    setEditingQAItemId(id);
    setQaItemForm({
      categoryId: item.categoryId,
      category: item.category,
      question: item.question,
      keywords: item.keywords,
      answer: item.answer,
      image: item.image,
      imageUrl: item.imageUrl,
      weight: item.weight,
      enabled: item.enabled,
    });
    setIsAddQAItemModalOpen(true);
  };

  const handleDeleteQAItem = async (id: string) => {
    const item = qaItems.find((candidate) => candidate.id === id);
    if (!item) return;
    try {
      await deleteQaEntry(id);
      await refreshQaPage();
      const summary = await getKnowledgeBase(item.baseId);
      const updatedBase = mapQABase(summary);
      setQaBases((prev) => prev.map((base) => base.id === updatedBase.id ? updatedBase : base));
      setSelectedQABase((current) => current?.id === updatedBase.id ? updatedBase : current);
    } catch (error) {
      setQaNotice(error instanceof Error ? error.message : '删除问答失败');
    }
  };

  const handleDeleteQABase = async (id: string) => {
    try {
      await deleteUnusedKnowledgeBase(id);
      setQaBases((prev) => prev.filter((base) => base.id !== id));
      if (selectedQABase?.id === id) setSelectedQABase(null);
    } catch (error) {
      setQaNotice(error instanceof Error ? error.message : '删除问答库失败');
    }
  };

  const handleSetQABasePublic = async (id: string, isPublic: boolean) => {
    try {
      const saved = await updateKnowledgeBase(id, { is_public: isPublic });
      const mapped = mapQABase(saved);
      setQaBases((prev) => prev.map((base) => base.id === id ? mapped : base));
      setSelectedQABase((current) => current?.id === id ? mapped : current);
      setRobotKnowledgeBases((prev) => prev.map((base) => base.id === id ? saved : base));
    } catch (error) {
      setQaNotice(error instanceof Error ? error.message : '更新公开状态失败');
    }
  };

  const toggleQAItem = async (id: string) => {
    const item = qaItems.find((candidate) => candidate.id === id);
    if (!item) return;
    try {
      const saved = await updateQaEntry(id, {
        category_id: item.categoryId,
        category: item.category,
        question: item.question,
        keywords: item.keywords.split(/[、,，\n]/).map((value) => value.trim()).filter(Boolean),
        answer: item.answer,
        image_url: item.imageUrl,
        weight: item.weight,
        enabled: !item.enabled,
      });
      setQaItems((prev) => prev.map((candidate) => candidate.id === id ? mapQAItem(saved) : candidate));
    } catch (error) {
      setQaNotice(error instanceof Error ? error.message : '更新启用状态失败');
    }
  };

  const handleCreateQaCategory = async () => {
    const name = newQaCategoryName.trim();
    if (!selectedQABase || !name) return;
    setIsCreatingQaCategory(true);
    setQaNotice('');
    try {
      const created = await createQaCategory(selectedQABase.id, name);
      setQaCategories((current) => [...current, created]);
      setQaItemForm((current) => ({ ...current, categoryId: created.id, category: created.name }));
      setNewQaCategoryName('');
    } catch (error) {
      setQaNotice(error instanceof Error ? error.message : '新增分类失败');
    } finally {
      setIsCreatingQaCategory(false);
    }
  };

  const changeQaCategoryFilter = (categoryId: string) => {
    setQaCategoryFilter(categoryId);
    setQaPage(1);
  };

  const submitQaSearch = () => {
    setQaKeyword(qaKeywordDraft.trim());
    setQaPage(1);
  };

  const handleAddProductKB = async () => {
    const name = newProductKBForm.name.trim();
    if (!name) return;
    setIsSavingProductKB(true);
    setProductKBNotice('');
    try {
      const created = await createKnowledgeBase(name, 'product', '', newProductKBForm.isPublic);
      const mapped = mapProductBase(created);
      setProductBases((prev) => [mapped, ...prev]);
      setRobotKnowledgeBases((prev) => prev.some((base) => base.id === created.id)
        ? prev.map((base) => base.id === created.id ? created : base)
        : [created, ...prev]);
      setNewProductKBForm({ name: '', isPublic: false });
      setIsAddProductKBModalOpen(false);
      setProductKBNotice('产品知识库已创建');
    } catch (error) {
      setProductKBNotice(error instanceof Error ? error.message : '创建产品知识库失败');
    } finally {
      setIsSavingProductKB(false);
    }
  };

  const handleDeleteProductKB = async (id: string) => {
    setProductKBNotice('');
    try {
      await deleteUnusedKnowledgeBase(id);
      setProductBases((prev) => prev.filter((base) => base.id !== id));
      setRobotKnowledgeBases((prev) => prev.filter((base) => base.id !== id));
      setProductDocuments((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (selectedProductKB?.id === id) setSelectedProductKB(null);
      setProductKBNotice('产品知识库已删除');
    } catch (error) {
      setProductKBNotice(error instanceof Error ? error.message : '删除产品知识库失败');
    }
  };

  const handleSetProductKBPublic = async (id: string, isPublic: boolean) => {
    try {
      const saved = await updateKnowledgeBase(id, { is_public: isPublic });
      const mapped = mapProductBase(saved);
      setProductBases((prev) => prev.map((base) => base.id === id ? mapped : base));
      setSelectedProductKB((current) => current?.id === id ? mapped : current);
      setRobotKnowledgeBases((prev) => prev.map((base) => base.id === id ? saved : base));
    } catch (error) {
      setProductKBNotice(error instanceof Error ? error.message : '更新公开状态失败');
    }
  };

  const mapProductDocument = (document: KnowledgeDocument): ProductDocument => ({
    id: document.id,
    name: document.original_filename || document.title,
    size: `${Math.max(1, Math.round(document.file_size / 1024))} KB`,
    format: document.file_type.toUpperCase(),
    status: document.status === 'ready' ? '已解析' : document.status === 'deleted' ? '已删除' : '待解析',
    date: document.updated_at.slice(0, 10),
    chunkCount: document.chunk_count,
    chunkStrategyVersion: document.chunk_strategy_version,
  });

  const openProductDocumentDetail = async (document: ProductDocument) => {
    setSelectedProductDocument(document);
    setProductDocumentDetail(null);
    setProductDocumentChunks([]);
    setProductDocumentDetailNotice('');
    setIsLoadingProductDocumentDetail(true);
    try {
      const [detail, firstPage] = await Promise.all([
        getKnowledgeDocument(document.id),
        listKnowledgeDocumentChunks(document.id),
      ]);
      let chunks = firstPage.items;
      for (let page = 2; page <= firstPage.pages; page += 1) {
        const nextPage = await listKnowledgeDocumentChunks(document.id, page);
        chunks = [...chunks, ...nextPage.items];
      }
      setProductDocumentDetail(detail);
      setProductDocumentChunks(chunks);
    } catch (error) {
      setProductDocumentDetailNotice(error instanceof Error ? error.message : '文档处理结果加载失败');
    } finally {
      setIsLoadingProductDocumentDetail(false);
    }
  };

  const closeProductDocumentDetail = () => {
    setSelectedProductDocument(null);
    setProductDocumentDetail(null);
    setProductDocumentChunks([]);
    setProductDocumentDetailNotice('');
    setIsLoadingProductDocumentDetail(false);
    setIsReprocessingProductDocument(false);
  };

  const handleReprocessProductDocument = async () => {
    if (!selectedProductDocument || !selectedProductKB?.isOwner || isReprocessingProductDocument) return;
    setIsReprocessingProductDocument(true);
    setProductDocumentDetailNotice('');
    try {
      const updated = await reprocessKnowledgeDocument(selectedProductDocument.id);
      const mapped = mapProductDocument(updated);
      setProductDocuments((prev) => ({
        ...prev,
        [selectedProductKB.id]: (prev[selectedProductKB.id] ?? []).map((document) => (
          document.id === mapped.id ? mapped : document
        )),
      }));
      setSelectedProductDocument(mapped);
      await openProductDocumentDetail(mapped);
      setProductImportNotice('文档已按最新结构化切片策略重新处理');
    } catch (error) {
      setProductDocumentDetailNotice(error instanceof Error ? error.message : '文档重新处理失败');
    } finally {
      setIsReprocessingProductDocument(false);
    }
  };

  const openProductKBConfig = async (id: string) => {
    const base = productBases.find((candidate) => candidate.id === id);
    if (!base) return;
    setSelectedProductKB(base);
    setProductKBName(base.name);
    setSelectedProductFile(null);
    setProductImportProgress(0);
    setProductImportNotice('正在加载文档列表...');
    setIsLoadingProductDocuments(true);
    try {
      const [documents, summary] = await Promise.all([
        listProductDocuments(base.id),
        getKnowledgeBase(base.id),
      ]);
      const mapped = documents.map(mapProductDocument);
      const refreshed = mapProductBase(summary);
      setProductDocuments((prev) => ({ ...prev, [id]: mapped }));
      setProductBases((prev) => prev.map((item) => item.id === id ? refreshed : item));
      setSelectedProductKB(refreshed);
      setProductKBName(refreshed.name);
      setProductImportNotice(mapped.length ? '' : '暂无文档，请选择文件导入');
    } catch (error) {
      setProductImportNotice(error instanceof Error ? error.message : '文档列表加载失败');
    } finally {
      setIsLoadingProductDocuments(false);
    }
  };

  const closeProductKBConfig = () => {
    setSelectedProductKB(null);
    setProductKBName('');
    setSelectedProductFile(null);
    setIsImportingProductDocument(false);
    setProductImportProgress(0);
    setProductImportNotice('');
  };

  const handleUpdateProductKB = async () => {
    if (!selectedProductKB || !productKBName.trim()) return;
    setIsSavingProductKB(true);
    setProductKBNotice('');
    try {
      const saved = await updateKnowledgeBase(selectedProductKB.id, { name: productKBName.trim() });
      const mapped = mapProductBase(saved);
      setProductBases((prev) => prev.map((base) => base.id === mapped.id ? mapped : base));
      setSelectedProductKB(mapped);
      setProductKBName(mapped.name);
      setRobotKnowledgeBases((prev) => prev.map((base) => base.id === saved.id ? saved : base));
      setProductImportNotice('知识库名称已保存');
    } catch (error) {
      setProductImportNotice(error instanceof Error ? error.message : '保存知识库名称失败');
    } finally {
      setIsSavingProductKB(false);
    }
  };

  const selectProductFile = (file: File | null) => {
    setSelectedProductFile(file);
    setProductImportNotice('');
  };

  const handleImportProductDocument = async () => {
    if (!selectedProductKB || !selectedProductFile || isImportingProductDocument) return;
    const file = selectedProductFile;
    const baseId = selectedProductKB.id;
    setIsImportingProductDocument(true);
    setProductImportProgress(10);
    setProductImportNotice('正在导入文档...');
    try {
      const imported = await importProductDocument(selectedProductKB.id, file);
      const document = mapProductDocument(imported);
      setProductImportProgress(100);
      if (!imported.duplicate) setProductDocuments((prev) => ({ ...prev, [baseId]: [...(prev[baseId] ?? []), document] }));
      const summary = await getKnowledgeBase(baseId);
      const refreshed = mapProductBase(summary);
      setProductBases((prev) => prev.map((base) => base.id === baseId ? refreshed : base));
      setSelectedProductKB(refreshed);
      setRobotKnowledgeBases((prev) => prev.map((base) => base.id === summary.id ? summary : base));
      setSelectedProductFile(null);
      setProductImportNotice(imported.duplicate ? '该文档已存在，未重复导入' : '文档已导入并完成切片');
    } catch (error) {
      setProductImportNotice(error instanceof Error ? error.message : '文档导入失败');
    } finally {
      setIsImportingProductDocument(false);
    }
  };

  const handleDeleteProductDocument = (documentId: string) => {
    if (!selectedProductKB) return;
    const baseId = selectedProductKB.id;
    deleteKnowledgeDocument(documentId)
      .then(() => {
        setProductDocuments((prev) => ({
          ...prev,
          [baseId]: (prev[baseId] ?? []).filter((document) => document.id !== documentId),
        }));
        return getKnowledgeBase(baseId);
      })
      .then((summary) => {
        const refreshed = mapProductBase(summary);
        setProductBases((prev) => prev.map((base) => base.id === baseId ? refreshed : base));
        setSelectedProductKB(refreshed);
        setRobotKnowledgeBases((prev) => prev.map((base) => base.id === summary.id ? summary : base));
        setProductImportNotice('文档已删除');
      })
      .catch((error: Error) => setProductImportNotice(error.message));
  };

  const refreshProductDocuments = async () => {
    if (!selectedProductKB) return;
    setIsLoadingProductDocuments(true);
    setProductImportNotice('正在刷新文档列表...');
    try {
      const [documents, summary] = await Promise.all([
        listProductDocuments(selectedProductKB.id),
        getKnowledgeBase(selectedProductKB.id),
      ]);
      const mappedDocuments = documents.map(mapProductDocument);
      const refreshed = mapProductBase(summary);
      setProductDocuments((prev) => ({ ...prev, [selectedProductKB.id]: mappedDocuments }));
      setProductBases((prev) => prev.map((base) => base.id === refreshed.id ? refreshed : base));
      setSelectedProductKB(refreshed);
      setProductKBName(refreshed.name);
      setProductImportNotice(mappedDocuments.length ? '文档列表已刷新' : '暂无文档，请选择文件导入');
    } catch (error) {
      setProductImportNotice(error instanceof Error ? error.message : '刷新文档列表失败');
    } finally {
      setIsLoadingProductDocuments(false);
    }
  };

  const openAddToneKB = () => {
    setEditingToneKBId(null);
    setNewToneKBForm({ name: '', persona: '', isPublic: false });
    setToneKBNotice('');
    setIsAddToneKBModalOpen(true);
  };

  const openEditToneKB = (id: string) => {
    const base = toneBases.find((candidate) => candidate.id === id);
    if (!base) return;
    setEditingToneKBId(id);
    setNewToneKBForm({ name: base.name, persona: base.persona, isPublic: base.isPublic });
    setToneKBNotice('');
    setIsAddToneKBModalOpen(true);
  };

  const handleSetToneKBPublic = async (id: string, isPublic: boolean) => {
    try {
      const saved = await updateKnowledgeBase(id, { is_public: isPublic });
      const mapped = mapToneBase(saved);
      setToneBases((prev) => prev.map((base) => base.id === id ? mapped : base));
      setRobotKnowledgeBases((prev) => prev.map((base) => base.id === id ? saved : base));
    } catch (error) {
      setToneKBNotice(error instanceof Error ? error.message : '更新公开状态失败');
    }
  };

  const handleSaveToneKB = async () => {
    if (!newToneKBForm.name.trim() || !newToneKBForm.persona.trim()) return;
    setIsSavingToneKB(true);
    setToneKBNotice('');
    try {
      const saved = editingToneKBId
        ? await updateKnowledgeBase(editingToneKBId, {
          name: newToneKBForm.name.trim(),
          persona: newToneKBForm.persona.trim(),
          is_public: newToneKBForm.isPublic,
        })
        : await createKnowledgeBase(newToneKBForm.name.trim(), 'tone', newToneKBForm.persona.trim(), newToneKBForm.isPublic);
      const mapped = mapToneBase(saved);
      setToneBases((prev) => editingToneKBId
        ? prev.map((base) => base.id === mapped.id ? mapped : base)
        : [mapped, ...prev]);
      setRobotKnowledgeBases((prev) => prev.some((base) => base.id === saved.id)
        ? prev.map((base) => base.id === saved.id ? saved : base)
        : [saved, ...prev]);
      setIsAddToneKBModalOpen(false);
      setEditingToneKBId(null);
      setNewToneKBForm({ name: '', persona: '', isPublic: false });
      setToneKBNotice('语气知识库已保存');
    } catch (error) {
      setToneKBNotice(error instanceof Error ? error.message : '保存语气知识库失败');
    } finally {
      setIsSavingToneKB(false);
    }
  };

  const handleDeleteToneKB = async (id: string) => {
    setToneKBNotice('');
    try {
      const usage = await getKnowledgeBaseUsage(id);
      if (usage.in_use) {
        const names = usage.robots.map((robot) => robot.name).join('、');
        setToneKBNotice(`该语气知识库正被机器人“${names}”使用，请先解除绑定`);
        return;
      }
      await deleteUnusedKnowledgeBase(id);
      setToneBases((prev) => prev.filter((base) => base.id !== id));
      setRobotKnowledgeBases((prev) => prev.filter((base) => base.id !== id));
      setToneKBNotice('语气知识库已删除');
    } catch (error) {
      setToneKBNotice(error instanceof Error ? error.message : '删除语气知识库失败');
    }
  };

  const toggleMenu = (id: string) => {
    setExpandedMenus((prev) => (prev.includes(id) ? prev.filter((menuId) => menuId !== id) : [...prev, id]));
  };

  const handleEditPlan = (id: string | 'new') => {
    setSelectedPlanId(id);
    setActiveTab('agent-detail');
  };

  const openRobotConfig = (id: string | null) => {
    setSelectedRobotId(id);
    setRobotNotice('');
    setRobotSubTab('base');
    setActiveTab('robot-base');
  };

  const saveRobot = async (input: RobotInput) => {
    setIsSavingRobot(true);
    setRobotNotice('');
    try {
      const saved = selectedRobotId
        ? await updateRobot(selectedRobotId, input)
        : await createRobot(input);
      setSelectedRobotId(saved.id);
      setRobots((prev) => {
        const mapped = mapRobot(saved, platformAccounts, robotKnowledgeBases);
        return prev.some((robot) => robot.id === saved.id)
          ? prev.map((robot) => robot.id === saved.id ? mapped : robot)
          : [mapped, ...prev];
      });
      setRobotNotice('机器人配置已保存');
    } catch (error) {
      setRobotNotice(error instanceof Error ? error.message : '机器人配置保存失败');
      throw error;
    } finally {
      setIsSavingRobot(false);
    }
  };

  const persistRobotStatus = async (id: string) => {
    const robot = robots.find((item) => item.id === id);
    if (!robot) return;
    const status = robot.status === 'online' ? 'offline' : 'online';
    try {
      const saved = await updateRobot(id, { status, enabled: status === 'online' });
      setRobots((prev) => prev.map((item) => item.id === id ? mapRobot(saved, platformAccounts, robotKnowledgeBases) : item));
    } catch (error) {
      setRobotNotice(error instanceof Error ? error.message : '机器人状态更新失败');
    }
  };

  const persistDeleteRobot = async (id: string) => {
    try {
      await deleteRobot(id);
      setRobots((prev) => prev.filter((robot) => robot.id !== id));
      if (selectedRobotId === id) setSelectedRobotId(null);
    } catch (error) {
      setRobotNotice(error instanceof Error ? error.message : '机器人删除失败');
    }
  };

  return {
    activeTab,
    setActiveTab,
    selectedPlanId,
    setSelectedPlanId,
    robots,
    platformAccounts,
    robotKnowledgeBases,
    selectedRobotId,
    selectedRobot: selectedRobotId ? robots.find((robot) => robot.id === selectedRobotId) ?? null : null,
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
    setQaItems,
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
    isReprocessingProductDocument,
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
    handleSetQABasePublic,
    toggleQAItem,
    handleAddProductKB,
    handleDeleteProductKB,
    handleSetProductKBPublic,
    openProductKBConfig,
    closeProductKBConfig,
    handleUpdateProductKB,
    selectProductFile,
    handleImportProductDocument,
    handleDeleteProductDocument,
    refreshProductDocuments,
    openProductDocumentDetail,
    closeProductDocumentDetail,
    handleReprocessProductDocument,
    openAddToneKB,
    openEditToneKB,
    handleSetToneKBPublic,
    handleSaveToneKB,
    handleDeleteToneKB,
    toggleMenu,
    handleEditPlan,
    openRobotConfig,
    saveRobot,
    toggleRobotStatus: persistRobotStatus,
    handleDeleteRobot: persistDeleteRobot,
    aiModels,
    isLoadingAiModels,
    isSyncingAiModels,
    aiConfigNotice,
    handleSyncAiModels,
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
  };
}

export type AdminController = ReturnType<typeof useAdminController>;
