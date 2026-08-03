import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, ArrowLeft, Globe, Key, Shield, User, UserRound } from 'lucide-react';

interface RegisterScreenProps {
  onRegister: (username: string, displayName: string, password: string) => Promise<void>;
  onShowLogin: () => void;
  lang: 'zh' | 'en';
  onToggleLang: () => void;
}

export default function RegisterScreen({ onRegister, onShowLogin, lang, onToggleLang }: RegisterScreenProps) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const t = {
    zh: {
      title: '创建客服账号',
      subtitle: '注册后将直接进入消息中心',
      username: '登录账号',
      usernamePlaceholder: '3-64 位字母、数字或 . _ -',
      displayName: '显示名称',
      displayNamePlaceholder: '例如：售前客服小王',
      password: '登录密码',
      passwordPlaceholder: '至少 8 位',
      confirmPassword: '确认密码',
      submit: '注册并登录',
      back: '返回登录',
      empty: '请完整填写注册信息',
      invalidUsername: '账号只能包含字母、数字、点、下划线或连字符，长度为 3-64 位',
      shortPassword: '密码长度不能少于 8 位',
      mismatch: '两次输入的密码不一致',
    },
    en: {
      title: 'Create Agent Account',
      subtitle: 'Continue to Messages after registration',
      username: 'Login Account',
      usernamePlaceholder: '3-64 letters, numbers or . _ -',
      displayName: 'Display Name',
      displayNamePlaceholder: 'e.g. Support Agent',
      password: 'Password',
      passwordPlaceholder: 'At least 8 characters',
      confirmPassword: 'Confirm Password',
      submit: 'Register and Login',
      back: 'Back to Login',
      empty: 'Please complete all fields',
      invalidUsername: 'Use 3-64 letters, numbers, dots, underscores or hyphens',
      shortPassword: 'Password must contain at least 8 characters',
      mismatch: 'Passwords do not match',
    },
  }[lang];

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!username.trim() || !displayName.trim() || !password || !confirmPassword) {
      setError(t.empty);
      return;
    }
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username.trim())) {
      setError(t.invalidUsername);
      return;
    }
    if (password.length < 8) {
      setError(t.shortPassword);
      return;
    }
    if (password !== confirmPassword) {
      setError(t.mismatch);
      return;
    }
    setIsLoading(true);
    try {
      await onRegister(username, displayName, password);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '注册失败，请稍后重试');
    } finally {
      setIsLoading(false);
    }
  };

  const fields = [
    { id: 'register-username', label: t.username, value: username, setValue: setUsername, placeholder: t.usernamePlaceholder, type: 'text', icon: User },
    { id: 'register-display-name', label: t.displayName, value: displayName, setValue: setDisplayName, placeholder: t.displayNamePlaceholder, type: 'text', icon: UserRound },
    { id: 'register-password', label: t.password, value: password, setValue: setPassword, placeholder: t.passwordPlaceholder, type: 'password', icon: Key },
    { id: 'register-confirm-password', label: t.confirmPassword, value: confirmPassword, setValue: setConfirmPassword, placeholder: t.passwordPlaceholder, type: 'password', icon: Shield },
  ];

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-50 relative overflow-hidden">
      <div className="absolute inset-0 opacity-[0.025] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#0ea5e9 1px, transparent 1px)', backgroundSize: '32px 32px' }} />
      <button onClick={onToggleLang} className="absolute top-6 right-6 z-10 flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm">
        <Globe size={14} />
        <span>{lang === 'zh' ? 'English' : '中文'}</span>
      </button>

      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md p-8 bg-white border border-slate-200 rounded-3xl shadow-xl relative z-10">
        <button type="button" onClick={onShowLogin} className="flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-sky-600 mb-6" id="back-to-login-btn">
          <ArrowLeft size={15} /> {t.back}
        </button>
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-slate-800">{t.title}</h1>
          <p className="text-xs text-slate-400 mt-2 font-medium">{t.subtitle}</p>
        </div>

        {error && (
          <div className="mb-5 p-3.5 bg-rose-50 border border-rose-100 rounded-xl text-rose-600 text-xs flex gap-2.5" id="register-error-alert">
            <AlertCircle size={16} className="flex-shrink-0" />
            <span className="font-semibold">{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {fields.map(({ id, label, value, setValue, placeholder, type, icon: Icon }) => (
            <label key={id} className="block space-y-1.5">
              <span className="text-xs font-bold text-slate-500">{label}</span>
              <span className="relative block">
                <Icon size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                <input id={id} type={type} value={value} onChange={(event) => setValue(event.target.value)} placeholder={placeholder} disabled={isLoading} className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 outline-none focus:ring-2 focus:ring-sky-500/10 focus:border-sky-500" />
              </span>
            </label>
          ))}
          <button type="submit" disabled={isLoading} className="w-full py-3.5 bg-sky-500 hover:bg-sky-600 text-white font-bold rounded-xl text-sm shadow-lg shadow-sky-500/10 disabled:bg-slate-300" id="register-submit-btn">
            {isLoading ? '...' : t.submit}
          </button>
        </form>
      </motion.div>
    </div>
  );
}
