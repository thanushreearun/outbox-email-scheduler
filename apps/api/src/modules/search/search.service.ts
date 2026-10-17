import type { Client } from '@elastic/elasticsearch';
import type { EmailStatus, Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import type { Db } from '../../lib/prisma.js';
import type { Logger } from '../../lib/logger.js';

export interface SearchParams {
  userId: string;
  q: string;
  statuses?: EmailStatus[];
  page: number;
  pageSize: number;
}

export interface SearchResult {
  ids: string[];
  total: number;
  source: 'elasticsearch' | 'database';
}

/**
 * Tenant isolation: the userId filter is applied in a `filter` clause built server-side
 * from the session, never from request input. Queries use the structured DSL only; user
 * text is passed as a value, never interpolated into query syntax.
 */
export class SearchService {
  constructor(private readonly deps: { es: Client; db: Db; logger: Logger }) {}

  async search(params: SearchParams): Promise<SearchResult> {
    try {
      return await this.searchElasticsearch(params);
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message },
        'elasticsearch search failed; using database fallback',
      );
      return this.searchDatabase(params);
    }
  }

  private async searchElasticsearch({
    userId,
    q,
    statuses,
    page,
    pageSize,
  }: SearchParams): Promise<SearchResult> {
    const filter: Array<Record<string, unknown>> = [{ term: { userId } }];
    if (statuses?.length) filter.push({ terms: { status: statuses } });

    const res = await this.deps.es.search<{ userId: string }>({
      index: env.ELASTICSEARCH_INDEX,
      from: (page - 1) * pageSize,
      size: pageSize,
      track_total_hits: true,
      _source: false,
      query: {
        bool: {
          filter,
          must: q
            ? [
                {
                  bool: {
                    should: [
                      {
                        multi_match: {
                          query: q,
                          type: 'bool_prefix',
                          fields: [
                            'subject^3',
                            'subject._2gram',
                            'subject._3gram',
                            'recipientName^2',
                            'recipientName._2gram',
                            'recipientEmail.parts^2',
                            'senderEmail.parts',
                          ],
                        },
                      },
                      { term: { recipientEmail: { value: q.toLowerCase(), boost: 5 } } },
                    ],
                    minimum_should_match: 1,
                  },
                },
              ]
            : [{ match_all: {} }],
        },
      },
      sort: q ? ['_score', { scheduledAt: 'desc' }] : [{ scheduledAt: 'desc' }],
    });
    const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? 0);
    return { ids: res.hits.hits.map((h) => h._id!).filter(Boolean), total, source: 'elasticsearch' };
  }

  private async searchDatabase({ userId, q, statuses, page, pageSize }: SearchParams): Promise<SearchResult> {
    const where: Prisma.EmailWhereInput = {
      userId,
      ...(statuses?.length ? { status: { in: statuses } } : {}),
      ...(q
        ? {
            OR: [
              { subject: { contains: q, mode: 'insensitive' } },
              { recipientEmail: { contains: q, mode: 'insensitive' } },
              { recipientName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.deps.db.email.findMany({
        where,
        select: { id: true },
        orderBy: { scheduledAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.deps.db.email.count({ where }),
    ]);
    return { ids: rows.map((r) => r.id), total, source: 'database' };
  }
}
