import { useLocale } from '../../shared/i18n/react';
import { localized } from '../../shared/i18n';
import type { EvidenceHit } from '../../shared/api';

export const SOURCE_LABEL: Record<EvidenceHit['source'], string> = localized({
  skill_content: 'Skill 正文（上下文中）',
  skill_file: 'SKILL.md（磁盘）',
  skills_listing: 'Skill 列表',
  user: '用户 / agent 消息',
  tool_output: '之前的工具输出',
  agents_md: 'AGENTS.md',
  memory: 'Memory',
  assistant: '之前的助手输出',
  other: '其他',
});

/** `text` with the matched words marked. */
export function Highlight({ text, words }: { text: string; words: string[] }) {
  useLocale();
  const escaped = words
    .filter((w) => w.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return <>{text}</>;
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-700/50">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
