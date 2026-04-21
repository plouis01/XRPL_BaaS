// Permission service routes. See PLAN.md §7 / ARCHITECTURE.md §4.4.
// XLS-75 V1.1 pending. Pre-V1.1 fallback: multi-sign with role-specific signer lists.
//
// POST   /                            → grant permissions to delegate
// GET    /:delegator                  → list all delegates
// DELETE /:delegator/:delegate        → revoke
// GET    /audit/:delegator            → audit log

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { revocationCheck } from '../middleware/revocationCheck.ts';
import {
  PermissionServiceError,
  getDelegationAudit,
  grantPermission,
  listDelegations,
  revokePermission,
} from '../services/permission.service.ts';
import type { AppEnv } from '../types.ts';
import { grantPermissionSchema, revokePermissionSchema } from '../validators/schemas.ts';

const permissions = new Hono<AppEnv>();

permissions.use('*', revocationCheck);

function permErrorResponse(err: PermissionServiceError) {
  switch (err.code) {
    case 'not_found':
      return { error: 'Delegation not found', status: 404 } as const;
    case 'not_managed':
      return { error: err.message, status: 400 } as const;
    case 'invalid_input':
      return { error: err.message, status: 400 } as const;
    case 'already_exists':
      return { error: err.message, status: 409 } as const;
    case 'enqueue_failed':
      return {
        error: 'Failed to enqueue — please retry',
        status: 503,
      } as const;
    case 'db_conflict':
      return { error: 'Conflict — please retry', status: 409 } as const;
  }
}

// POST / — grant permissions to a delegate
permissions.post('/', zValidator('json', grantPermissionSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await grantPermission({
      clientId,
      delegatorAddress: body.delegator_address,
      delegateAddress: body.delegate_address,
      permissions: [...body.permissions],
      weight: body.weight,
      quorum: body.quorum,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof PermissionServiceError) {
      const r = permErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// GET /audit/:delegator — audit log (MUST be before /:delegator to avoid param catch)
permissions.get('/audit/:delegator', async (c) => {
  const clientId = c.get('clientId');
  const delegator = c.req.param('delegator');
  try {
    const result = await getDelegationAudit(clientId, delegator);
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof PermissionServiceError) {
      const r = permErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// GET /:delegator — list all active delegates
permissions.get('/:delegator', async (c) => {
  const clientId = c.get('clientId');
  const delegator = c.req.param('delegator');
  try {
    const result = await listDelegations(clientId, delegator);
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof PermissionServiceError) {
      const r = permErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// DELETE /:delegator/:delegate — revoke delegation
permissions.delete(
  '/:delegator/:delegate',
  zValidator('json', revokePermissionSchema),
  async (c) => {
    const clientId = c.get('clientId');
    const delegator = c.req.param('delegator');
    const delegate = c.req.param('delegate');
    const body = c.req.valid('json');
    // Body delegator_address must match path param
    if (body.delegator_address !== delegator) {
      return c.json({ error: 'delegator_address does not match URL' }, 400);
    }
    try {
      const result = await revokePermission({
        clientId,
        delegatorAddress: delegator,
        delegateAddress: delegate,
        idempotencyKey: c.req.header('idempotency-key'),
      });
      return c.json({ ...result, status: 'queued' }, 202);
    } catch (err) {
      if (err instanceof PermissionServiceError) {
        const r = permErrorResponse(err);
        return c.json({ error: r.error }, r.status);
      }
      throw err;
    }
  },
);

export default permissions;
