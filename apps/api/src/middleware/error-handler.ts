import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

/** Consistent error envelope; never leaks stack traces or provider responses. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = String(req.id ?? '');
  let status = 500;
  let body: ErrorBody['error'] = { code: 'INTERNAL', message: 'Something went wrong', requestId };

  if (err instanceof AppError) {
    status = err.status;
    body = { code: err.code, message: err.message, details: err.details, requestId };
  } else if (err instanceof ZodError) {
    status = 400;
    body = {
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      requestId,
    };
  } else if (err instanceof MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    body = { code: err.code, message: err.message, requestId };
  } else if (isBodyParserError(err)) {
    status = err.status;
    body = {
      code: err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY',
      message: err.message,
      requestId,
    };
  }

  if (status >= 500) {
    (req.log ?? logger).error({ err }, 'unhandled error');
  }
  res.status(status).json({ error: body });
}

function isBodyParserError(err: unknown): err is { status: number; type: string; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    'status' in err &&
    typeof err.status === 'number'
  );
}
