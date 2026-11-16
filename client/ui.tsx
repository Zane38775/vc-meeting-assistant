import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { X, LoaderCircle, ArrowUpRight, FileText } from 'lucide-react';

export const ModalErrorContext = createContext('');
export function Modal({ title, description, children, close, wide = false }: { title: string; description?: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const error = useContext(ModalErrorContext);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog className={`modal ${wide ? 'wide' : ''}`} ref={ref} onCancel={close} onClick={event => { if (event.target === ref.current) close(); }}>
    <div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="关闭弹窗" onClick={close}><X size={20} /></button></div>
    {error && <div className="inline-error modal-error" role="alert">{error}</div>}
    {children}
  </dialog>;
}
export function Empty({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol"><FileText size={24} strokeWidth={1.5} /></div><h3>{title}</h3><p>{detail}</p>{children}</div>;
}
export function Spinner({ text = '正在加载' }: { text?: string }) { return <span className="loading-inline"><LoaderCircle size={16} className="spin" />{text}</span>; }
export function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  try { const parsed = new URL(url); if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return <span>{children}</span>; }
  catch { return <span>{children}</span>; }
  return <a href={url} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={14} /></a>;
}
export const formatDate = (value: number) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const timecode = (value: number) => { const seconds = Math.max(0, Math.floor(value / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
export const roleLabel = { admin: '管理员', editor: '协作者', viewer: '观察者' };
export type Run = (key: string, task: () => Promise<void>) => Promise<void>;
