import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronsUpDown,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Type,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react';
import { cn } from '../../lib/cn';

function ToolButton({
  label,
  active,
  onClick,
  disabled,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-ink-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
        active && 'bg-brand-50 text-brand-700',
      )}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="mx-1.5 h-4 w-px bg-line" aria-hidden />;

function Dropdown({
  label,
  trigger,
  items,
}: {
  label: string;
  trigger: React.ReactNode;
  items: Array<{ label: string; icon?: React.ReactNode; active: boolean; run: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <ToolButton label={label} onClick={() => setOpen((v) => !v)}>
        {trigger}
      </ToolButton>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 min-w-[140px] rounded-lg border border-line bg-white py-1 shadow-pop"
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitemradio"
              aria-checked={it.active}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                it.run();
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface',
                it.active && 'font-semibold text-brand-700',
              )}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const chain = () => editor.chain().focus();
  const align =
    (['left', 'center', 'right', 'justify'] as const).find((a) => editor.isActive({ textAlign: a })) ??
    'left';
  const AlignIcon = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify }[align];
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-0.5 rounded-full bg-white px-2 py-1"
    >
      <ToolButton label="Undo" onClick={() => chain().undo().run()} disabled={!editor.can().undo()}>
        <Undo2 className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="Redo" onClick={() => chain().redo().run()} disabled={!editor.can().redo()}>
        <Redo2 className="h-4 w-4" />
      </ToolButton>
      <Divider />
      <Dropdown
        label="Text size"
        trigger={
          <span className="flex items-center gap-0.5">
            <Type className="h-4 w-4" />
            <ChevronDown className="h-3 w-3" />
          </span>
        }
        items={[
          { label: 'Normal', active: editor.isActive('paragraph'), run: () => chain().setParagraph().run() },
          {
            label: 'Large',
            active: editor.isActive('heading', { level: 3 }),
            run: () => chain().toggleHeading({ level: 3 }).run(),
          },
          {
            label: 'Larger',
            active: editor.isActive('heading', { level: 2 }),
            run: () => chain().toggleHeading({ level: 2 }).run(),
          },
          {
            label: 'Huge',
            active: editor.isActive('heading', { level: 1 }),
            run: () => chain().toggleHeading({ level: 1 }).run(),
          },
        ]}
      />
      <Divider />
      <ToolButton label="Bold" active={editor.isActive('bold')} onClick={() => chain().toggleBold().run()}>
        <Bold className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Italic"
        active={editor.isActive('italic')}
        onClick={() => chain().toggleItalic().run()}
      >
        <Italic className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Underline"
        active={editor.isActive('underline')}
        onClick={() => chain().toggleUnderline().run()}
      >
        <UnderlineIcon className="h-4 w-4" />
      </ToolButton>
      <Divider />
      <Dropdown
        label="Alignment"
        trigger={
          <span className="flex items-center gap-1">
            <AlignIcon className="h-4 w-4" />
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </span>
        }
        items={[
          {
            label: 'Left',
            icon: <AlignLeft className="h-4 w-4" />,
            active: align === 'left',
            run: () => chain().setTextAlign('left').run(),
          },
          {
            label: 'Center',
            icon: <AlignCenter className="h-4 w-4" />,
            active: align === 'center',
            run: () => chain().setTextAlign('center').run(),
          },
          {
            label: 'Right',
            icon: <AlignRight className="h-4 w-4" />,
            active: align === 'right',
            run: () => chain().setTextAlign('right').run(),
          },
          {
            label: 'Justify',
            icon: <AlignJustify className="h-4 w-4" />,
            active: align === 'justify',
            run: () => chain().setTextAlign('justify').run(),
          },
        ]}
      />
      <Divider />
      <ToolButton
        label="Numbered list"
        active={editor.isActive('orderedList')}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Bulleted list"
        active={editor.isActive('bulletList')}
        onClick={() => chain().toggleBulletList().run()}
      >
        <List className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Indent"
        onClick={() => chain().sinkListItem('listItem').run()}
        disabled={!editor.can().sinkListItem('listItem')}
      >
        <IndentIncrease className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Outdent"
        onClick={() => chain().liftListItem('listItem').run()}
        disabled={!editor.can().liftListItem('listItem')}
      >
        <IndentDecrease className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        label="Quote"
        active={editor.isActive('blockquote')}
        onClick={() => chain().toggleBlockquote().run()}
      >
        <Quote className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="Clear formatting" onClick={() => chain().unsetAllMarks().clearNodes().run()}>
        <RemoveFormatting className="h-4 w-4" />
      </ToolButton>
      <Divider />
      <ToolButton
        label="Strikethrough"
        active={editor.isActive('strike')}
        onClick={() => chain().toggleStrike().run()}
      >
        <Strikethrough className="h-4 w-4" />
      </ToolButton>
    </div>
  );
}

export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  invalid?: boolean;
}

/** TipTap (ProseMirror) editor; output is sanitised server-side with a matching allow-list. */
export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Type Your Reply...',
  invalid,
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        code: false,
        horizontalRule: false,
      }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class: 'email-prose min-h-[230px] px-3 py-2 text-[13px] leading-6 text-ink focus:outline-none',
        'aria-label': 'Email body',
        role: 'textbox',
        'aria-multiline': 'true',
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? '' : e.getHTML()),
  });

  // Keep external resets (e.g. after a successful send) in sync.
  useEffect(() => {
    if (editor && value === '' && !editor.isEmpty) editor.commands.clearContent();
  }, [editor, value]);

  return (
    <div className={cn('rounded-xl bg-surface px-3 pb-3 pt-3', invalid && 'ring-1 ring-red-300')}>
      {editor && <Toolbar editor={editor} />}
      <div className="relative mt-2">
        {editor?.isEmpty && (
          <span className="pointer-events-none absolute left-3 top-2 text-[13px] text-ink-muted" aria-hidden>
            {placeholder}
          </span>
        )}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
