// Credential service routes. See PLAN.md §7 / ARCHITECTURE.md §4.3.
// XLS-70. RailForge is NEVER the credential issuer — it brokers a marketplace.
//
// POST   /                  → issue credential (CredentialCreate)
// GET    /:id               → get credential details
// POST   /:id/accept        → accept credential (CredentialAccept)
// DELETE /:id               → revoke credential (CredentialDelete)
// POST   /verify            → check if account has valid credential
// GET    /issuers           → list marketplace issuers

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { revocationCheck } from '../middleware/revocationCheck.ts';
import {
  CredentialServiceError,
  acceptCredential,
  getCredential,
  issueCredential,
  listIssuers,
  revokeCredential,
  verifyCredential,
} from '../services/credential.service.ts';
import type { AppEnv } from '../types.ts';
import {
  acceptCredentialSchema,
  issueCredentialSchema,
  verifyCredentialSchema,
} from '../validators/schemas.ts';

const credentials = new Hono<AppEnv>();

credentials.use('*', revocationCheck);

function credentialErrorResponse(err: CredentialServiceError) {
  switch (err.code) {
    case 'not_found':
      return { error: 'Credential not found', status: 404 } as const;
    case 'not_managed':
      return { error: err.message, status: 400 } as const;
    case 'already_accepted':
      return { error: err.message, status: 409 } as const;
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

// POST / — issue a new credential
credentials.post('/', zValidator('json', issueCredentialSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await issueCredential({
      clientId,
      issuerAddress: body.issuer_address,
      subjectAddress: body.subject_address,
      credentialType: body.credential_type,
      expiration: body.expiration,
      uri: body.uri,
      metadata: body.metadata,
    });
    return c.json(result, 201);
  } catch (err) {
    if (err instanceof CredentialServiceError) {
      const r = credentialErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// GET /issuers — list marketplace issuers (must be before /:id)
credentials.get('/issuers', async (c) => {
  const issuers = await listIssuers();
  return c.json({ issuers });
});

// POST /verify — check if account has valid credential
credentials.post('/verify', zValidator('json', verifyCredentialSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  const result = await verifyCredential({
    clientId,
    subjectAddress: body.subject_address,
    issuerAddress: body.issuer_address,
    credentialType: body.credential_type,
  });
  return c.json(result);
});

// GET /:id — get credential details
credentials.get('/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  const cred = await getCredential(clientId, id);
  if (!cred) return c.json({ error: 'Credential not found' }, 404);
  return c.json(cred);
});

// POST /:id/accept — subject accepts a pending credential
credentials.post('/:id/accept', zValidator('json', acceptCredentialSchema), async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const result = await acceptCredential({
      clientId,
      credentialId: id,
      subjectAddress: body.subject_address,
    });
    return c.json({ ...result, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof CredentialServiceError) {
      const r = credentialErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// DELETE /:id — revoke/delete a credential
credentials.delete('/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  try {
    const result = await revokeCredential({ clientId, credentialId: id });
    return c.json({ ...result, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof CredentialServiceError) {
      const r = credentialErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

export default credentials;
