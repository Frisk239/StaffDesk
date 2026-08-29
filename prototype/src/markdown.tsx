import { useState, type ReactNode } from 'react';
import { Check, Copy } from '@phosphor-icons/react';

// 轻量 markdown：对齐 DSH AssistantMarkdown 的块型（标题 / 列表 / 代码块 / 引用 / 表 / 行内）。
// 流式时未闭合围栏按代码块收尾，不引入 marked。

type Block =
  | { t: 'h'; level: 1 | 2 | 3 | 4; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'pre'; lang: string; code: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'hr' };

function splitInline(text: string): ReactNode[] {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(
        <code key={k++}>{tok.slice(1, -1)}</code>,
      );
    } else if (tok.startsWith('**')) {
      out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    } else {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (mm) {
        out.push(
          <a key={k++} href={mm[2]} target="_blank" rel="noreferrer">
            {mm[1]}
          </a>,
        );
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ t: 'pre', lang, code: body.join('\n') });
      continue;
    }
    if (/^---+$/.test(line.trim()) || /^(\*\s*){3,}$/.test(line.trim())) {
      blocks.push({ t: 'hr' });
      i += 1;
      continue;
    }
    const hm = line.match(/^(#{1,4})\s+(.+)$/);
    if (hm) {
      blocks.push({ t: 'h', level: hm[1].length as 1 | 2 | 3 | 4, text: hm[2] });
      i += 1;
      continue;
    }
    if (line.startsWith('> ')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        q.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ t: 'quote', text: q.join('\n') });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      blocks.push({ t: 'ul', items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ t: 'ol', items });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const split = (s: string) =>
        s
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const head = split(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(split(lines[i]));
        i += 1;
      }
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isFenceStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ t: 'p', text: para.join('\n') });
  }
  return blocks;
}

function isFenceStart(line: string): boolean {
  return (
    line.startsWith('```') ||
    line.startsWith('#') ||
    line.startsWith('> ') ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^---+$/.test(line.trim())
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 原型不处理剪贴板失败 */
    }
  };
  return (
    <div className="md-code">
      <div className="md-code-banner">
        <span className="md-code-lang">{lang || 'text'}</span>
        <button className="md-code-copy" type="button" onClick={copy} title="复制">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const last = i === blocks.length - 1;
        const mark = last && caret ? <span className="stream-caret" /> : null;
        switch (b.t) {
          case 'h': {
            const Tag = (`h${b.level}` as 'h1' | 'h2' | 'h3' | 'h4');
            return (
              <Tag key={i}>
                {splitInline(b.text)}
                {mark}
              </Tag>
            );
          }
          case 'p':
            return (
              <p key={i}>
                {splitInline(b.text)}
                {mark}
              </p>
            );
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    {splitInline(it)}
                    {last && j === b.items.length - 1 ? mark : null}
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    {splitInline(it)}
                    {last && j === b.items.length - 1 ? mark : null}
                  </li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote key={i}>
                {splitInline(b.text)}
                {mark}
              </blockquote>
            );
          case 'pre':
            return (
              <div key={i}>
                <CodeBlock lang={b.lang} code={b.code} />
                {mark}
              </div>
            );
          case 'table':
            return (
              <div className="md-table-wrap" key={i}>
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j}>{splitInline(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, j) => (
                          <td key={j}>{splitInline(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {mark}
              </div>
            );
          case 'hr':
            return <hr key={i} />;
        }
      })}
      {blocks.length === 0 && caret ? <span className="stream-caret" /> : null}
    </div>
  );
}
