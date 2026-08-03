import { useEffect, useState } from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import { getQaImageUrl } from '../api/client';

interface ImagePreviewProps {
  src: string;
  alt?: string;
  className?: string;
  previewClassName?: string;
}

export default function ImagePreview({ src, alt = '图片', className = '', previewClassName = '' }: ImagePreviewProps) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = getQaImageUrl(src);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`inline-flex overflow-hidden rounded-lg border border-slate-200 bg-slate-50 ${className}`} title="点击查看大图">
        {failed ? (
          <span className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 text-[9px] text-slate-400">
            <ImageIcon className="h-4 w-4" />
            加载失败
          </span>
        ) : (
          <img src={url} alt={alt} onError={() => setFailed(true)} className="h-12 w-12 object-cover" />
        )}
      </button>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 p-6" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setOpen(false)}>
          <div className="relative flex max-h-[90vh] max-w-[90vw] items-center justify-center rounded-xl bg-white p-2 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => setOpen(false)} className="absolute -right-3 -top-3 z-10 rounded-full bg-white p-1.5 text-slate-500 shadow hover:text-slate-900" aria-label="关闭图片预览" title="关闭">
              <X className="h-5 w-5" />
            </button>
            {failed ? <div className="px-16 py-20 text-sm text-slate-500">图片加载失败</div> : <img src={url} alt={alt} onError={() => setFailed(true)} className={`max-h-[86vh] max-w-[86vw] rounded-lg object-contain ${previewClassName}`} />}
          </div>
        </div>
      )}
    </>
  );
}
