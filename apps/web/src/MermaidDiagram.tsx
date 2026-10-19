import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useEffect, useState } from 'react';
import { renderMermaidImage } from './diagramRendering';
import './diagram.css';

export function MermaidDiagram({ source, title = t('Mermaid 图表') }: { source: string; title?: string }) {
  useLocale();
  const [result, setResult] = useState<{ source: string; image?: string; width?: number; height?: number; error?: string }>();
  const [naturalSize, setNaturalSize] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    // Avoid rendering every intermediate keystroke in the architecture editor.
    const timer = window.setTimeout(() => {
      void renderMermaidImage(source, controller.signal).then(
        (rendered) => { if (!controller.signal.aborted) setResult({ source, ...rendered }); },
        (error: unknown) => {
          if (!controller.signal.aborted) setResult({ source, error: error instanceof Error ? error.message.slice(0, 1_200) : '图表渲染失败，请检查图源。' });
        },
      );
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [source]);

  const current = result?.source === source ? result : undefined;
  return <figure className="diagram-preview" aria-label={title}>
    {current?.image ? <><div className={`diagram-image-scroll${naturalSize ? ' diagram-image-natural' : ''}`}><img src={current.image} width={current.width} height={current.height} style={{ width: current.width }} alt={title} /></div>
      <div className="diagram-actions"><button type="button" onClick={() => setNaturalSize((value) => !value)}>{naturalSize ? t('适应宽度') : t('原始大小')}</button></div></>
      : current?.error ? <p className="diagram-error" role="alert">{t("无法显示 Mermaid 图表：")}{t(current.error)}</p>
        : <p className="diagram-status" role="status">{t("正在生成图表…")}</p>}
    <details className="diagram-source" open={Boolean(current?.error)}>
      <summary>{t("Mermaid 图源")}</summary>
      <pre><code>{source}</code></pre>
    </details>
  </figure>;
}
