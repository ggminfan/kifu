import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Markdown without raw HTML (agent output is untrusted). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-kifu">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
