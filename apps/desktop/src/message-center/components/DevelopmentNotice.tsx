import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface DevelopmentNoticeProps {
  trigger: number;
  message: string;
}

export default function DevelopmentNotice({ trigger, message }: DevelopmentNoticeProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (trigger === 0) return undefined;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 1800);
    return () => window.clearTimeout(timer);
  }, [message, trigger]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: '-50%', y: -8, scale: 0.96 }}
          animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
          exit={{ opacity: 0, x: '-50%', y: -8, scale: 0.96 }}
          role="status"
          aria-live="polite"
          className="fixed left-1/2 top-6 z-[100] rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 shadow-xl"
        >
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
