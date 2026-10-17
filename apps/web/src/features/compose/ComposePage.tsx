import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, Clock, Paperclip } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  useConfig,
  useDeleteAttachment,
  useScheduleEmails,
  useSenders,
  useUploadAttachment,
} from '../../hooks/queries';
import { describeError } from '../../lib/api';
import { cn } from '../../lib/cn';
import type { PublicConfig } from '../../types/api';
import { Button, IconButton } from '../../components/ui/Button';
import { ErrorState, FullPageSpinner } from '../../components/ui/States';
import { ACCEPTED_ATTACHMENTS, AttachmentList, MAX_ATTACHMENTS, type DraftAttachment } from './Attachments';
import { makeComposeSchema, type ComposeOutput, type ComposeValues } from './composeSchema';
import { RecipientInput } from './RecipientInput';
import { RichTextEditor } from './RichTextEditor';
import { scheduleTimeError, SendLaterPopover } from './SendLaterPopover';

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="mt-1 text-2xs text-red-600">
      {message}
    </p>
  ) : null;
}

const newKey = () => crypto.randomUUID();

export function ComposePage() {
  const config = useConfig();
  if (config.isPending) return <FullPageSpinner />;
  if (config.isError)
    return <ErrorState message={describeError(config.error)} onRetry={() => void config.refetch()} />;
  return <ComposeForm config={config.data} />;
}

function ComposeForm({ config }: { config: PublicConfig }) {
  const navigate = useNavigate();
  const senders = useSenders();
  const schedule = useScheduleEmails();
  const upload = useUploadAttachment();
  const removeAttachment = useDeleteAttachment();
  const [laterOpen, setLaterOpen] = useState(false);
  const [scheduledFor, setScheduledFor] = useState<Date | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // One key per compose session: retries/double-clicks of the same submission are de-duplicated server-side.
  const idempotencyKey = useRef(newKey());

  const form = useForm<ComposeValues, unknown, ComposeOutput>({
    resolver: zodResolver(makeComposeSchema(config)),
    defaultValues: {
      senderAccountId: '',
      recipients: [],
      subject: '',
      bodyHtml: '',
      delaySeconds: '',
      hourlyLimit: '',
    },
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });
  const { register, control, handleSubmit, setValue, formState } = form;
  const errors = formState.errors;

  const activeSenders = useMemo(() => senders.data?.filter((s) => s.isActive) ?? [], [senders.data]);
  useEffect(() => {
    if (!form.getValues('senderAccountId') && activeSenders[0])
      setValue('senderAccountId', activeSenders[0].id);
  }, [activeSenders, form, setValue]);

  useEffect(() => () => attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) toast.error(`At most ${MAX_ATTACHMENTS} attachments`);
    for (const file of list) {
      if (file.size > config.maxAttachmentBytes) {
        toast.error(`${file.name} is larger than ${Math.round(config.maxAttachmentBytes / 1024 / 1024)} MB`);
        continue;
      }
      const draft: DraftAttachment = {
        localId: crypto.randomUUID(),
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        status: 'uploading',
      };
      setAttachments((prev) => [...prev, draft]);
      upload.mutate(file, {
        onSuccess: (meta) =>
          setAttachments((prev) =>
            prev.map((a) => (a.localId === draft.localId ? { ...a, status: 'ready', id: meta.id } : a)),
          ),
        onError: (err) =>
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === draft.localId ? { ...a, status: 'error', error: describeError(err) } : a,
            ),
          ),
      });
    }
  }

  function dropAttachment(localId: string) {
    const a = attachments.find((x) => x.localId === localId);
    if (a?.id) removeAttachment.mutate(a.id);
    if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
    setAttachments((prev) => prev.filter((x) => x.localId !== localId));
  }

  const uploading = attachments.some((a) => a.status === 'uploading');
  const busy = schedule.isPending || uploading;

  const submit = (when: Date) =>
    handleSubmit(
      (values) => {
        if (attachments.some((a) => a.status === 'error'))
          return toast.error('Remove failed attachments first');
        schedule.mutate(
          {
            idempotencyKey: idempotencyKey.current,
            body: {
              senderAccountId: values.senderAccountId,
              recipients: values.recipients,
              subject: values.subject,
              bodyHtml: values.bodyHtml,
              startAt: when.toISOString(), // local wall-clock → UTC instant
              delayBetweenMs: values.delaySeconds !== undefined ? values.delaySeconds * 1000 : undefined,
              hourlyLimit: values.hourlyLimit ?? null,
              attachmentIds: attachments.flatMap((a) => (a.id ? [a.id] : [])),
            },
          },
          {
            onSuccess: (res) => {
              const skipped = res.rejected.length + res.duplicatesRemoved;
              toast.success(
                `${res.replayed ? 'Already scheduled' : 'Scheduled'} ${res.accepted} email${res.accepted === 1 ? '' : 's'}` +
                  (res.firstScheduledAt
                    ? ` · first send ${format(new Date(res.firstScheduledAt), 'MMM d, h:mm a')}`
                    : ''),
                {
                  description: skipped ? `${skipped} recipient(s) skipped (invalid or duplicate)` : undefined,
                },
              );
              idempotencyKey.current = newKey();
              setScheduledFor(null);
              setLaterOpen(false);
              navigate('/scheduled');
            },
            onError: (err) => toast.error(describeError(err)),
          },
        );
      },
      () => {
        setLaterOpen(false);
        toast.error('Please fix the highlighted fields');
      },
    )();

  /** Sends at the time chosen in the popover; never falls back to "now". */
  function scheduleAtSelectedTime() {
    const error = scheduleTimeError(scheduledFor);
    setScheduleError(error);
    if (!error && scheduledFor) void submit(scheduledFor);
  }

  function selectTime(when: Date | null) {
    setScheduledFor(when);
    setScheduleError(null);
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col pb-10">
      <header className="flex items-center gap-3 px-3 py-3 sm:px-[10px]">
        <IconButton label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-5 w-5 text-ink" />
        </IconButton>
        <h1 className="flex-1 text-[19px] font-medium text-ink">Compose New Email</h1>
        <div className="relative flex items-center gap-1">
          <IconButton
            label={`Attach files (${attachments.length})`}
            onClick={() => fileRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
          >
            <Paperclip className={cn('h-[18px] w-[18px]', attachments.length ? 'text-brand-600' : '')} />
            {attachments.length > 0 && (
              <span className="absolute bottom-0.5 right-0.5 text-[9px] font-semibold text-ink">
                {attachments.length}
              </span>
            )}
          </IconButton>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPTED_ATTACHMENTS}
            className="hidden"
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <IconButton label="Schedule send" onClick={() => setLaterOpen((v) => !v)} aria-expanded={laterOpen}>
            <Clock className="h-[18px] w-[18px] text-brand-600" />
          </IconButton>
          {laterOpen ? (
            // With a time picked this confirms the schedule; otherwise it is an explicit send-now.
            <Button
              variant="outline"
              size="sm"
              className="ml-2 min-w-[70px]"
              loading={schedule.isPending}
              disabled={busy}
              onClick={scheduledFor ? scheduleAtSelectedTime : () => submit(new Date())}
            >
              {scheduledFor ? 'Schedule' : 'Send now'}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="ml-2"
              disabled={busy}
              onClick={() => setLaterOpen(true)}
            >
              Send Later
            </Button>
          )}
          {laterOpen && (
            <SendLaterPopover
              selected={scheduledFor}
              onSelect={selectTime}
              error={scheduleError}
              busy={schedule.isPending}
              onCancel={() => setLaterOpen(false)}
              onConfirm={scheduleAtSelectedTime}
            />
          )}
        </div>
      </header>

      <form
        noValidate
        onSubmit={(e) => e.preventDefault()}
        className="mx-auto w-full max-w-[744px] px-4 pt-4 sm:px-0"
      >
        <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-y-3 sm:grid-cols-[40px_minmax(0,1fr)] sm:gap-x-4">
          <label htmlFor="sender" className="pt-2 text-[12px] text-ink">
            From
          </label>
          <div>
            {senders.isPending ? (
              <div className="h-[30px] w-48 animate-pulse rounded-md bg-surface" />
            ) : activeSenders.length === 0 ? (
              <p className="pt-1.5 text-[12px] text-ink-muted">
                No active sender.{' '}
                <Link to="/settings" className="font-medium text-brand-600 hover:underline">
                  Add one in Settings
                </Link>
                .
              </p>
            ) : (
              <div className="relative inline-flex max-w-full">
                <select
                  id="sender"
                  {...register('senderAccountId')}
                  className="h-[30px] max-w-full truncate appearance-none rounded-md bg-surface-search py-1 pl-2.5 pr-8 text-[13px] text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                >
                  {activeSenders.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName ? `${s.displayName} <${s.email}>` : s.email}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
                  aria-hidden
                />
              </div>
            )}
            <FieldError message={errors.senderAccountId?.message} />
          </div>

          <label htmlFor="recipients" className="pt-2.5 text-[12px] text-ink">
            To
          </label>
          <div>
            <Controller
              control={control}
              name="recipients"
              render={({ field }) => (
                <RecipientInput
                  value={field.value as Array<{ email: string; name: string | null }>}
                  onChange={field.onChange}
                  max={config.maxRecipientsPerBatch}
                  invalid={Boolean(errors.recipients)}
                />
              )}
            />
            <FieldError message={errors.recipients?.message ?? errors.recipients?.root?.message} />
          </div>

          <label htmlFor="subject" className="pt-2.5 text-[12px] text-ink">
            Subject
          </label>
          <div>
            <input
              id="subject"
              {...register('subject')}
              placeholder="Subject"
              aria-invalid={Boolean(errors.subject) || undefined}
              className={cn(
                'h-[37px] w-full border-b bg-transparent text-[13px] placeholder:text-ink-faint focus:border-brand-400 focus:outline-none',
                errors.subject ? 'border-red-300' : 'border-line',
              )}
            />
            <FieldError message={errors.subject?.message} />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-start gap-x-5 gap-y-2">
          <div>
            <label className="flex items-center gap-2.5 text-[12px] text-ink">
              Delay between 2 emails
              <input
                {...register('delaySeconds')}
                inputMode="numeric"
                placeholder={String(Math.ceil(config.minDelayBetweenEmailsMs / 1000)).padStart(2, '0')}
                aria-describedby="delay-help"
                aria-invalid={Boolean(errors.delaySeconds) || undefined}
                className={cn(
                  'h-[28px] w-[50px] rounded-md border px-2 text-[13px] placeholder:text-ink-faint focus:border-brand-400 focus:outline-none',
                  errors.delaySeconds ? 'border-red-300' : 'border-line',
                )}
              />
            </label>
            <p id="delay-help" className="mt-1 text-[10px] text-ink-faint">
              seconds · min {Math.ceil(config.minDelayBetweenEmailsMs / 1000)}
            </p>
            <FieldError message={errors.delaySeconds?.message} />
          </div>
          <div>
            <label className="flex items-center gap-2.5 text-[12px] text-ink">
              Hourly Limit
              <input
                {...register('hourlyLimit')}
                inputMode="numeric"
                placeholder="00"
                aria-describedby="limit-help"
                aria-invalid={Boolean(errors.hourlyLimit) || undefined}
                className={cn(
                  'h-[28px] w-[50px] rounded-md border px-2 text-[13px] placeholder:text-ink-faint focus:border-brand-400 focus:outline-none',
                  errors.hourlyLimit ? 'border-red-300' : 'border-line',
                )}
              />
            </label>
            <p id="limit-help" className="mt-1 text-[10px] text-ink-faint">
              per hour · max {config.maxEmailsPerHourPerSender}
            </p>
            <FieldError message={errors.hourlyLimit?.message} />
          </div>
        </div>

        <div className="mt-3">
          <Controller
            control={control}
            name="bodyHtml"
            render={({ field }) => (
              <RichTextEditor
                value={field.value}
                onChange={field.onChange}
                invalid={Boolean(errors.bodyHtml)}
              />
            )}
          />
          <FieldError message={errors.bodyHtml?.message} />
        </div>

        <AttachmentList items={attachments} onRemove={dropAttachment} />
      </form>
    </main>
  );
}
