// 资料全文 Markdown 渲染（K54 编辑页 / 查看弹窗共用）。
// html:false 挡原始 HTML 注入（配合 linkify），渲染产物经 dangerouslySetInnerHTML 输出。
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true });

export function renderMarkdown(source: string): string {
  return md.render(source);
}
