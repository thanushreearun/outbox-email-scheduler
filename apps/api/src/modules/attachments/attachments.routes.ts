import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { sha256 } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import type { Db } from '../../lib/prisma.js';
import { currentUser } from '../../middleware/auth.js';

/** Allowed types with magic-byte signatures; the client-declared MIME type is not trusted alone. */
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 6).toString('ascii').startsWith('GIF8'),
  'image/webp': (b) =>
    b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('ascii') === '%PDF-',
  'text/plain': (b) => !b.includes(0),
  'text/csv': (b) => !b.includes(0),
};

export function detectAllowedType(declared: string, buf: Buffer): string | null {
  const check = SIGNATURES[declared];
  return check && check(buf) ? declared : null;
}

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

export function safeFilename(name: string): string {
  const base = path.basename(name).replace(UNSAFE_FILENAME_CHARS, '_').trim();
  return (base || 'attachment').slice(0, 120);
}

export function attachmentsRouter(db: Db): Router {
  const r = Router();
  const uploadDir = path.resolve(env.UPLOAD_DIR);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.MAX_ATTACHMENT_BYTES, files: 1, fields: 0 },
  });

  r.post('/', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('Missing "file" field');
    const mimeType = detectAllowedType(file.mimetype, file.buffer);
    if (!mimeType) {
      throw new AppError(
        415,
        'UNSUPPORTED_FILE',
        'Allowed: PNG, JPEG, GIF, WebP, PDF, TXT, CSV (content must match type)',
      );
    }
    const userId = currentUser(req).id;
    const pending = await db.attachment.count({ where: { userId, batchId: null } });
    if (pending >= 20) throw badRequest('Too many unattached uploads; send or remove some first');

    const storageKey = randomUUID();
    await mkdir(uploadDir, { recursive: true });
    await writeFile(path.join(uploadDir, storageKey), file.buffer, { flag: 'wx' });
    const row = await db.attachment.create({
      data: {
        userId,
        filename: safeFilename(file.originalname),
        mimeType,
        sizeBytes: file.size,
        storageKey,
        sha256: sha256(file.buffer),
      },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true },
    });
    res.status(201).json({ data: row });
  });

  r.get('/:id/content', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const row = await db.attachment.findFirst({ where: { id, userId: currentUser(req).id } });
    if (!row) throw notFound('Attachment not found');
    const inline = row.mimeType.startsWith('image/');
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    );
    createReadStream(path.join(uploadDir, row.storageKey))
      .on('error', () => res.destroy())
      .pipe(res);
  });

  r.delete('/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const row = await db.attachment.findFirst({ where: { id, userId: currentUser(req).id } });
    if (!row) throw notFound('Attachment not found');
    if (row.batchId) throw conflict('Attachment belongs to a scheduled email and cannot be removed');
    await db.attachment.delete({ where: { id } });
    await unlink(path.join(uploadDir, row.storageKey)).catch(() => undefined);
    res.status(204).end();
  });

  return r;
}
