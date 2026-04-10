// Audit log middleware. Logs every state-changing /v1/* request to the
// audit_log table (PLAN.md §9.2 #2).
//
// Runs AFTER the handler so we can capture the response status code.
// Only logs POST, PUT, DELETE — GETs are read-only and high-volume.
//
// The insert is fire-and-forget: a failed audit write must NEVER block
// or fail the actual API response. We log the error and move on.

import { createHash } from 'node:crypto';
import { db, schema } from '@railforge/db';
import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger.ts';
import type { AppEnv } from '../types.ts';

const AUDITED_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export const auditLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  const method = c.req.method;
  if (!AUDITED_METHODS.has(method)) return;

  const clientId = c.get('clientId');
  const apiKeyId = c.get('apiKeyId');

  // Both are set by auth middleware. If missing, this request was
  // unauthenticated (shouldn't reach here due to middleware order, but
  // guard defensively).
  if (!clientId || !apiKeyId) return;

  // SHA-256 of the raw body so we can correlate duplicate requests
  // without storing PII in the audit table.
  let requestHash: string | null = null;
  try {
    const body = await c.req.raw.clone().text();
    if (body) {
      requestHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    }
  } catch {
    // Body may not be readable (e.g., already consumed). Skip hash.
  }

  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;

  // Fire-and-forget — don't await in the response path.
  db.insert(schema.auditLog)
    .values({
      clientId,
      apiKeyId,
      method,
      path: c.req.path,
      statusCode: c.res.status,
      ip,
      requestHash,
    })
    .catch((err) => {
      logger.error({ err, path: c.req.path }, 'audit log insert failed (non-fatal)');
    });

  return;
};
