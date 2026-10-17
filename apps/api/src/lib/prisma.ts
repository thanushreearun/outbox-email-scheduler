import { PrismaClient } from '@prisma/client';

// Query errors are thrown to the caller and logged by the error handler or worker,
// so Prisma only prints its own warnings (expected conflicts would otherwise be logged as errors).
export const prisma = new PrismaClient({
  log: [{ emit: 'stdout', level: 'warn' }],
});

export type Db = typeof prisma;
