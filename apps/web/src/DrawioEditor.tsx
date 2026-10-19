import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useEffect, useRef, useState } from 'react';
import { createDrawioSession, DRAWIO_ORIGIN, drawioFrameUrl, readDrawioEvent, type DrawioSaveResult } from './drawioProtocol';
import './diagram.css';

interface DrawioEditorProps {
  source: string;
  onSave: (result: DrawioSaveResult) => void;
  onClose: () => void;
}

export function DrawioEditor(props: DrawioEditorProps) {
  return <DrawioFrame key={props.source} {...props} title={t("draw.io 架构图编辑器")} />;
}

export function DrawioFrame({ source, readOnly = false, title, onSave, onClose }: {
  source: string;
  readOnly?: boolean;
  title: string;
  onSave?: (result: DrawioSaveResult) => void;
  onClose?: () => void;
}) {
  useLocale();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef({ onSave, onClose });
  callbacks.current = { onSave, onClose };
  const sessionRef = useRef<ReturnType<typeof createDrawioSession> | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Keep the iframe language fixed for this session so switching UI language preserves unsaved diagram edits.
  const [frameUrl] = useState(() => drawioFrameUrl(readOnly));
  const [status, setStatus] = useState('正在加载 draw.io…');
  const [error, setError] = useState<string | null>(null);
  const [hasPendingSource, setHasPendingSource] = useState(false);

  useEffect(() => {
    let exportTimer: number | undefined;
    const loadTimer = window.setTimeout(() => {
      setError('draw.io 暂时无法连接。可重试，或关闭后使用图源编辑。');
    }, 15_000);
    const session = createDrawioSession({
      source,
      readOnly,
      send: (message) => frameRef.current?.contentWindow?.postMessage(JSON.stringify(message), DRAWIO_ORIGIN),
      onLoaded: () => { window.clearTimeout(loadTimer); setStatus(''); setError(null); },
      onError: (message) => {
        window.clearTimeout(loadTimer);
        window.clearTimeout(exportTimer);
        setHasPendingSource(sessionRef.current?.hasPendingSource() ?? false);
        setStatus('');
        setError(message);
      },
      onExporting: () => {
        window.clearTimeout(exportTimer);
        setHasPendingSource(true);
        setError(null);
        setStatus('正在生成图源对应的预览…');
        exportTimer = window.setTimeout(() => {
          setStatus('');
          setError('预览生成超时，可保留图源后稍后重试预览。');
        }, 15_000);
      },
      onSave: (result) => {
        window.clearTimeout(exportTimer);
        setHasPendingSource(false);
        setStatus('图源已返回，保存架构资料后生成新版本。');
        setError(null);
        callbacks.current.onSave?.(result);
      },
      onExit: (modified) => {
        if (!modified || window.confirm(t('图表有尚未保存的修改，确定关闭吗？'))) callbacks.current.onClose?.();
      },
    });
    sessionRef.current = session;
    const receive = (event: MessageEvent) => {
      const message = readDrawioEvent(event, frameRef.current?.contentWindow ?? null);
      if (message) session.receive(message);
    };
    window.addEventListener('message', receive);
    return () => {
      session.dispose();
      sessionRef.current = null;
      window.clearTimeout(loadTimer);
      window.clearTimeout(exportTimer);
      window.removeEventListener('message', receive);
    };
  }, [source, readOnly, attempt]);

  return <div className="diagram-preview">
    {status && <p className="diagram-status" role="status">{t(status)}</p>}
    {error && <p className="diagram-error" role="alert">{t(error)}</p>}
    <iframe key={attempt} ref={frameRef} src={frameUrl} title={title}
      className={`diagram-frame${readOnly ? '' : ' diagram-frame-editor'}`}
      sandbox="allow-scripts allow-same-origin allow-downloads" referrerPolicy="no-referrer"
      onError={() => { setStatus(''); setError('draw.io 加载失败，可重试或使用图源编辑。'); }} />
    {(error || !readOnly) && <div className="diagram-actions">
      {error && !hasPendingSource && <button type="button" onClick={() => { setError(null); setStatus('正在加载 draw.io…'); setAttempt((value) => value + 1); }}>{t("重新加载")}</button>}
      {error && hasPendingSource && <button type="button" onClick={() => sessionRef.current?.saveSourceOnly()}>{t("保留图源并关闭")}</button>}
      {!readOnly && <button type="button" onClick={() => {
        if (window.confirm(t('关闭编辑器将放弃尚未返回的图表修改，确定关闭吗？'))) callbacks.current.onClose?.();
      }}>{t("关闭编辑器")}</button>}
    </div>}
  </div>;
}
