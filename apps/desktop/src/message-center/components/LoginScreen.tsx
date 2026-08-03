/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Shield, Key, User, Globe, AlertCircle } from 'lucide-react';

interface LoginScreenProps {
  onLogin: (username: string, password: string) => Promise<void>;
  onShowRegister: () => void;
  lang: 'zh' | 'en';
  onToggleLang: () => void;
}

export default function LoginScreen({ onLogin, onShowRegister, lang, onToggleLang }: LoginScreenProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const t = {
    zh: {
      title: 'AI智能客服平台',
      subtitle: '多平台智能客服接入与托管控制台',
      userLabel: '账号',
      passLabel: '密码',
      userPlaceholder: '请输入账号',
      passPlaceholder: '请输入密码',
      submit: '立即登录',
      register: '没有账号？立即注册',
      errorEmpty: '账号和密码不能为空',
      mockTips: '开发账号: admin | 密码: admin123',
      secureTip: '账号由本地业务服务安全验证',
    },
    en: {
      title: 'AI Customer Service Platform',
      subtitle: 'Multi-platform Customer Service Integration & Hosting Console',
      userLabel: 'Account',
      passLabel: 'Password',
      userPlaceholder: 'Please enter account',
      passPlaceholder: 'Please enter password',
      submit: 'Login Now',
      register: 'No account? Register now',
      errorEmpty: 'Username and password cannot be empty',
      mockTips: 'Dev Account: admin | Password: admin123',
      secureTip: 'Credentials are verified by the local business API',
    }
  }[lang];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!username.trim() || !password.trim()) {
      setError(t.errorEmpty);
      return;
    }

    setIsLoading(true);
    try {
      await onLogin(username, password);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '登录失败，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 relative overflow-hidden" id="login-container">
      {/* Background ambient light */}
      <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-sky-100 rounded-full blur-3xl opacity-60 pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] bg-indigo-100 rounded-full blur-3xl opacity-40 pointer-events-none" />
      <div className="absolute inset-0 opacity-[0.02] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#0ea5e9 1px, transparent 1px)', backgroundSize: '32px 32px' }} />

      {/* Language Switcher */}
      <div className="absolute top-6 right-6 z-10">
        <button
          onClick={onToggleLang}
          className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 hover:border-slate-300 rounded-xl text-xs font-bold text-slate-600 transition-all shadow-sm"
          id="lang-switch-btn"
        >
          <Globe size={14} />
          <span>{lang === 'zh' ? 'English' : '中文'}</span>
        </button>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="w-full max-w-md p-8 bg-white border border-slate-200/80 rounded-3xl shadow-xl relative z-10"
      >
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-sky-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-sky-500/20">
            <Shield size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">{t.title}</h1>
          <p className="text-xs text-slate-400 mt-2 font-medium">{t.subtitle}</p>
        </div>

        {error && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mb-6 p-4 bg-rose-50 border border-rose-100 rounded-2xl text-rose-600 text-xs flex items-start gap-2.5"
            id="login-error-alert"
          >
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span className="font-semibold">{error}</span>
          </motion.div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">{t.userLabel}</label>
            <div className="relative">
              <User size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t.userPlaceholder}
                className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200/80 rounded-2xl text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/10 focus:border-sky-500 transition-all font-medium"
                id="login-username"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">{t.passLabel}</label>
            <div className="relative">
              <Key size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t.passPlaceholder}
                className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200/80 rounded-2xl text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500/10 focus:border-sky-500 transition-all font-medium"
                id="login-password"
              />
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3.5 bg-sky-500 hover:bg-sky-600 text-white font-bold rounded-2xl text-sm transition-all shadow-lg shadow-sky-500/10 hover:shadow-sky-500/20 active:scale-[0.98] flex items-center justify-center gap-2 disabled:bg-slate-300 disabled:shadow-none disabled:cursor-not-allowed"
              id="login-submit-btn"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <span>{t.submit}</span>
              )}
            </button>
          </div>
        </form>

        <button
          type="button"
          onClick={onShowRegister}
          className="mt-5 w-full text-center text-xs font-bold text-sky-600 hover:text-sky-700 transition-colors"
          id="show-register-btn"
        >
          {t.register}
        </button>

        <div className="mt-8 pt-6 border-t border-slate-100 flex flex-col items-center gap-3 text-center">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider bg-slate-50 px-2.5 py-1 rounded-lg">
            {t.mockTips}
          </span>
          <span className="text-[10px] text-slate-300 font-semibold uppercase tracking-wider">
            {t.secureTip}
          </span>
        </div>
      </motion.div>
    </div>
  );
}
