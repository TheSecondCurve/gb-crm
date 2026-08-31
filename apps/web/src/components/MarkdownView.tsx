// Markdown 只读视图：renderMarkdown 产物（html:false 已挡注入）直接 innerHTML。
// 样式走 .markdown-body（base.css）。
import { useMemo } from "react";

import { renderMarkdown } from "../lib/markdown";

interface MarkdownViewProps {
  source: string;
  className?: string;
}

export function MarkdownView({ source, className }: MarkdownViewProps) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className={className ? `markdown-body ${className}` : "markdown-body"}
      // markdown-it html:false：原始 HTML 不会被注入，可安全 innerHTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
