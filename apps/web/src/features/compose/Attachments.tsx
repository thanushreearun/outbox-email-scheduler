import { FileText, Loader2, X } from 'lucide-react';
import { fileSize } from '../../lib/format';

export interface DraftAttachment {
  localId: string;
  file: File;
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'error';
  id?: string;
  error?: string;
}

export const ACCEPTED_ATTACHMENTS =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv';
export const MAX_ATTACHMENTS = 5;

/** Thumbnail cards (preview, name, size) shown below the editor. */
export function AttachmentList({
  items,
  onRemove,
}: {
  items: DraftAttachment[];
  onRemove: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-3" aria-label="Attachments">
      {items.map((a) => (
        <li
          key={a.localId}
          className="group relative w-[150px] overflow-hidden rounded-lg border border-line bg-white"
        >
          {a.previewUrl ? (
            <img src={a.previewUrl} alt="" className="h-[84px] w-full object-cover" />
          ) : (
            <div className="flex h-[84px] items-center justify-center bg-surface">
              <FileText className="h-6 w-6 text-ink-muted" aria-hidden />
            </div>
          )}
          <div className="px-2 py-1.5">
            <p className="truncate text-2xs text-ink" title={a.file.name}>
              {a.file.name}
            </p>
            <p className="text-[10px] text-ink-muted">
              {a.status === 'uploading' ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Uploading
                </span>
              ) : a.status === 'error' ? (
                <span className="text-red-600">{a.error ?? 'Upload failed'}</span>
              ) : (
                fileSize(a.file.size)
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label={`Remove ${a.file.name}`}
            onClick={() => onRemove(a.localId)}
            className="absolute right-1 top-1 rounded-full bg-white/90 p-0.5 text-ink-muted shadow hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
