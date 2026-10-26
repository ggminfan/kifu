import { describe, expect, it } from 'vitest';
import { quoteFinder, quoteFound } from '../src/core/analysis/quotes';

describe('quotes', () => {
  it('finds a quote copied with other punctuation, spacing or case', () => {
    const text = '- 第 2 轮 用户：中文，按 feat 和 fix 分组。\n  agent 最后回答：Done — grouped by "area".';
    expect(quoteFound(text, '中文,按feat和fix分组')).toBe(true);
    expect(quoteFound(text, 'done - grouped by area')).toBe(true);
    expect(quoteFound(text, '用中文写，按模块分组')).toBe(false);
    // too short to say anything
    expect(quoteFound(text, '中文')).toBe(false);
    const find = quoteFinder(text);
    expect([find('按 feat 和 fix 分组'), find('…分组完毕')]).toEqual([true, false]);
  });
});
