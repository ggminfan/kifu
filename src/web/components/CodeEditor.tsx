import { markdown } from '@codemirror/lang-markdown';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

const theme = EditorView.theme({
  '&': { fontSize: '12px', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { padding: '6px 0' },
  '.cm-gutters': { background: 'transparent', border: 'none' },
});

const darkTheme = EditorView.theme(
  {
    '&': { color: '#e4e4e7', backgroundColor: '#09090b' },
    '.cm-cursor': { borderLeftColor: '#e4e4e7' },
    '.cm-activeLine': { backgroundColor: '#18181b' },
    '.cm-activeLineGutter': { backgroundColor: '#18181b' },
    '.cm-selectionBackground, ::selection': { backgroundColor: '#3730a3 !important' },
    '.cm-gutters': { color: '#52525b' },
  },
  { dark: true },
);

function isDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Markdown editor (CodeMirror 6). `value` is only applied when it differs from the editor content. */
export function CodeEditor({ value, onChange, readOnly = false, className }: { value: string; onChange?: (v: string) => void; readOnly?: boolean; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          theme,
          ...(isDark() ? [darkTheme] : []),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className={className} />;
}

/** Side-by-side diff of the original and the variant. */
export function MergeEditor({ original, modified, className }: { original: string; modified: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ext = [basicSetup, markdown(), EditorView.lineWrapping, theme, ...(isDark() ? [darkTheme] : []), EditorState.readOnly.of(true), EditorView.editable.of(false)];
    const mv = new MergeView({ a: { doc: original, extensions: ext }, b: { doc: modified, extensions: ext }, parent: host.current!, collapseUnchanged: { margin: 3, minSize: 6 } });
    return () => mv.destroy();
  }, [original, modified]);
  return <div ref={host} className={className} />;
}
