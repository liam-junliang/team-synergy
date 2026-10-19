import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useState } from 'react';
import { DrawioFrame } from './DrawioEditor';
import { svgImageUrl } from './diagramRendering';
import './diagram.css';

export function DrawioDiagram({ source, previewSvg, title = t('draw.io 架构图') }: { source: string; previewSvg?: string | null; title?: string }) {
  useLocale();
  const [interactiveSource, setInteractiveSource] = useState<string | null>(null);
  const preview = previewSvg ? svgImageUrl(previewSvg) : null;
  if (!preview || interactiveSource === source) {
    return <DrawioFrame key={source} source={source} title={title} readOnly />;
  }
  return <figure className="diagram-preview" aria-label={title}>
    <div className="diagram-image-scroll"><img src={preview} alt={title} /></div>
    <div className="diagram-actions"><button type="button" onClick={() => setInteractiveSource(source)}>{t("交互预览 / 查看所有页面")}</button></div>
  </figure>;
}
