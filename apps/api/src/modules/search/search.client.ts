import { Client } from '@elastic/elasticsearch';
import { env } from '../../config/env.js';
import type { Logger } from '../../lib/logger.js';

export function createSearchClient(): Client {
  return new Client({
    node: env.ELASTICSEARCH_URL,
    requestTimeout: 5_000,
    maxRetries: 1,
  });
}

/**
 * Mapping choices:
 * - `userId`, `status`, `senderAccountId`, `batchId`: keyword — exact filters only.
 * - `recipientEmail` / `senderEmail`: lowercase keyword for exact match plus a `parts`
 *   sub-field split on non-alphanumerics so "doe" or "example" find "john.doe@example.com".
 * - `subject` / `recipientName`: search_as_you_type for prefix matching while typing.
 * - Dates are real `date` fields so we can sort and range-filter.
 */
export const EMAIL_INDEX_BODY = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      normalizer: { lowercase_normalizer: { type: 'custom' as const, filter: ['lowercase'] } },
      tokenizer: { email_parts_tokenizer: { type: 'pattern' as const, pattern: '[^\\p{L}\\p{N}]+' } },
      analyzer: {
        email_parts: { type: 'custom' as const, tokenizer: 'email_parts_tokenizer', filter: ['lowercase'] },
      },
    },
  },
  mappings: {
    dynamic: 'strict' as const,
    properties: {
      userId: { type: 'keyword' as const },
      batchId: { type: 'keyword' as const },
      senderAccountId: { type: 'keyword' as const },
      senderEmail: {
        type: 'keyword' as const,
        normalizer: 'lowercase_normalizer',
        fields: { parts: { type: 'text' as const, analyzer: 'email_parts' } },
      },
      recipientEmail: {
        type: 'keyword' as const,
        normalizer: 'lowercase_normalizer',
        fields: { parts: { type: 'text' as const, analyzer: 'email_parts' } },
      },
      recipientName: { type: 'search_as_you_type' as const },
      subject: { type: 'search_as_you_type' as const },
      status: { type: 'keyword' as const },
      scheduledAt: { type: 'date' as const },
      sentAt: { type: 'date' as const },
      createdAt: { type: 'date' as const },
      updatedAt: { type: 'date' as const },
    },
  },
};

export async function ensureEmailIndex(client: Client, logger: Logger): Promise<boolean> {
  try {
    const exists = await client.indices.exists({ index: env.ELASTICSEARCH_INDEX });
    if (!exists) {
      await client.indices.create({ index: env.ELASTICSEARCH_INDEX, ...EMAIL_INDEX_BODY });
      logger.info({ index: env.ELASTICSEARCH_INDEX }, 'elasticsearch index created');
    }
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('resource_already_exists_exception')) return true;
    logger.warn({ err: msg }, 'elasticsearch unavailable; index will be ensured on next reconciliation');
    return false;
  }
}
