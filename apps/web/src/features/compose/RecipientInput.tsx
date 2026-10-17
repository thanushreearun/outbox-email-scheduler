import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { dedupeRecipients, parseRecipientText, type Recipient } from '../../lib/recipients';
import { cn } from '../../lib/cn';

const VISIBLE_CHIPS = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function RecipientChip({ recipient, onRemove }: { recipient: Recipient; onRemove: () => void }) {
  return (
    <span
      className="inline-flex h-[22px] max-w-[220px] items-center gap-1 rounded-full border border-brand-400 bg-brand-50 pl-2 pr-1 text-2xs text-ink"
      title={recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email}
    >
      <span className="truncate">{recipient.email}</span>
      <button
        type="button"
        aria-label={`Remove ${recipient.email}`}
        onClick={onRemove}
        className="rounded-full p-0.5 text-ink-muted hover:bg-brand-100 hover:text-ink"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

export interface RecipientInputProps {
  value: Recipient[];
  onChange: (next: Recipient[]) => void;
  max: number;
  invalid?: boolean;
}

export function RecipientInput({ value, onChange, max, invalid }: RecipientInputProps) {
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [lastReport, setLastReport] = useState<{ invalid: string[]; duplicates: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function add(text: string) {
    const parsed = parseRecipientText(text);
    const merged = dedupeRecipients(parsed.valid, value);
    const room = Math.max(0, max - value.length);
    const added = merged.valid.slice(0, room);
    if (merged.valid.length > room)
      toast.error(`Recipient limit is ${max}; ${merged.valid.length - room} not added`);
    if (added.length) onChange([...value, ...added]);
    const report = { invalid: parsed.invalid, duplicates: parsed.duplicates + merged.duplicates };
    setLastReport(report.invalid.length || report.duplicates ? report : null);
    return { added: added.length, ...report };
  }

  function commitDraft() {
    if (!draft.trim()) return;
    const res = add(draft);
    if (res.invalid.length === 0) setDraft('');
    else setDraft(res.invalid.join(', '));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (['Enter', ',', ';', 'Tab'].includes(e.key) && draft.trim()) {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault();
      add(text);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return toast.error('List file is larger than 5 MB');
    if (!/\.(csv|txt)$/i.test(file.name) && !['text/csv', 'text/plain'].includes(file.type)) {
      return toast.error('Upload a .csv or .txt file');
    }
    const res = add(await file.text());
    const extra = [
      res.invalid.length && `${res.invalid.length} invalid`,
      res.duplicates && `${res.duplicates} duplicates skipped`,
    ]
      .filter(Boolean)
      .join(', ');
    toast.success(
      `Added ${res.added} recipient${res.added === 1 ? '' : 's'} from ${file.name}${extra ? ` (${extra})` : ''}`,
    );
    setShowPreview(true);
  }

  const visible = expanded ? value : value.slice(0, VISIBLE_CHIPS);
  const hidden = value.length - visible.length;

  return (
    <div className="min-w-0 flex-1">
      <div
        className={cn(
          'flex min-h-[37px] items-center gap-3 border-b py-1.5',
          invalid ? 'border-red-300' : 'border-line',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {visible.map((r) => (
            <RecipientChip
              key={r.email}
              recipient={r}
              onRemove={() => onChange(value.filter((x) => x.email !== r.email))}
            />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="h-[22px] rounded-full border border-brand-400 bg-brand-50 px-2 text-2xs font-medium text-brand-700 hover:bg-brand-100"
              aria-label={`Show ${hidden} more recipients`}
            >
              +{hidden}
            </button>
          )}
          {expanded && value.length > VISIBLE_CHIPS && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-2xs text-ink-muted hover:underline"
            >
              Show less
            </button>
          )}
          <input
            id="recipients"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={commitDraft}
            placeholder={value.length ? '' : 'recipient@example.com'}
            aria-label="Add recipients"
            aria-invalid={invalid || undefined}
            className="min-w-[160px] flex-1 bg-transparent py-0.5 text-[13px] placeholder:text-ink-faint focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex shrink-0 items-center gap-1.5 text-[13px] font-medium text-brand-600 hover:text-brand-700"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden />
          Upload List
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="hidden"
          data-testid="recipient-file"
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {(value.length > 0 || lastReport) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-2xs text-ink-muted" aria-live="polite">
          <span data-testid="recipient-count">
            {value.length} recipient{value.length === 1 ? '' : 's'}
          </span>
          {lastReport?.duplicates ? (
            <span>
              {lastReport.duplicates} duplicate{lastReport.duplicates === 1 ? '' : 's'} skipped
            </span>
          ) : null}
          {lastReport?.invalid.length ? (
            <span className="text-red-600" title={lastReport.invalid.slice(0, 20).join(', ')}>
              {lastReport.invalid.length} invalid ignored
            </span>
          ) : null}
          {value.length > 0 && (
            <button
              type="button"
              className="text-brand-600 hover:underline"
              onClick={() => setShowPreview((v) => !v)}
            >
              {showPreview ? 'Hide list' : 'Preview list'}
            </button>
          )}
          {value.length > 0 && (
            <button type="button" className="hover:underline" onClick={() => onChange([])}>
              Clear all
            </button>
          )}
        </div>
      )}
      {showPreview && value.length > 0 && (
        <ol
          className="mt-2 max-h-40 overflow-auto rounded-lg border border-line bg-white py-1 text-2xs"
          aria-label="Recipient preview"
        >
          {value.slice(0, 500).map((r, i) => (
            <li key={r.email} className="flex gap-2 px-3 py-0.5">
              <span className="w-8 text-right text-ink-faint">{i + 1}.</span>
              <span className="truncate text-ink">{r.email}</span>
              {r.name && <span className="truncate text-ink-muted">{r.name}</span>}
            </li>
          ))}
          {value.length > 500 && <li className="px-3 py-1 text-ink-muted">…and {value.length - 500} more</li>}
        </ol>
      )}
    </div>
  );
}
