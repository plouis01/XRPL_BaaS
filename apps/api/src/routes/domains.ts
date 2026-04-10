// Domain service routes. See PLAN.md §7 / ARCHITECTURE.md §4.5.
// XLS-80 (Permissioned Domains).
//
// POST   /                → create permissioned domain
// GET    /:id             → get domain details
// PUT    /:id             → update accepted credentials
// DELETE /:id             → delete domain
// GET    /:id/members     → list members
// POST   /:id/check       → verify if account qualifies

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { revocationCheck } from '../middleware/revocationCheck.ts';
import {
  DomainServiceError,
  checkMembership,
  createDomain,
  deleteDomain,
  getDomain,
  listMembers,
  updateDomain,
} from '../services/domain.service.ts';
import type { AppEnv } from '../types.ts';
import {
  checkDomainMembershipSchema,
  createDomainSchema,
  updateDomainSchema,
} from '../validators/schemas.ts';

const domains = new Hono<AppEnv>();

domains.use('*', revocationCheck);

function domainErrorResponse(err: DomainServiceError) {
  switch (err.code) {
    case 'not_found':
      return { error: 'Domain not found', status: 404 } as const;
    case 'not_managed':
      return { error: err.message, status: 400 } as const;
    case 'invalid_input':
      return { error: err.message, status: 400 } as const;
    case 'enqueue_failed':
      return {
        error: 'Failed to enqueue — please retry',
        status: 503,
      } as const;
    case 'db_conflict':
      return { error: 'Conflict — please retry', status: 409 } as const;
  }
}

// POST / — create a new permissioned domain
domains.post('/', zValidator('json', createDomainSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await createDomain({
      clientId,
      ownerAddress: body.owner_address,
      acceptedCredentials: body.accepted_credentials,
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof DomainServiceError) {
      const r = domainErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// GET /:id — get domain details
domains.get('/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  const domain = await getDomain(clientId, id);
  if (!domain) return c.json({ error: 'Domain not found' }, 404);
  return c.json(domain);
});

// PUT /:id — update accepted credentials
domains.put('/:id', zValidator('json', updateDomainSchema), async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const result = await updateDomain({
      clientId,
      domainDbId: id,
      acceptedCredentials: body.accepted_credentials,
    });
    return c.json(result, 200);
  } catch (err) {
    if (err instanceof DomainServiceError) {
      const r = domainErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// DELETE /:id — delete domain
domains.delete('/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  try {
    const result = await deleteDomain({ clientId, domainDbId: id });
    return c.json({ ...result, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof DomainServiceError) {
      const r = domainErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// GET /:id/members — list all qualifying members
domains.get('/:id/members', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  try {
    const result = await listMembers(clientId, id);
    return c.json(result);
  } catch (err) {
    if (err instanceof DomainServiceError) {
      const r = domainErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// POST /:id/check — check if a specific account qualifies
domains.post('/:id/check', zValidator('json', checkDomainMembershipSchema), async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const result = await checkMembership({
      clientId,
      domainDbId: id,
      subjectAddress: body.subject_address,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof DomainServiceError) {
      const r = domainErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

export default domains;
