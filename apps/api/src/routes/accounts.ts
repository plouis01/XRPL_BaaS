import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { createAccountSchema } from '../validators/schemas.ts';

// Account service routes. See PLAN.md §4.1 / ARCHITECTURE.md §4.1.
// XRPL primitives: AccountSet, SignerListSet, AccountDelete, multi-signing.

const accounts = new Hono();

accounts.post('/', zValidator('json', createAccountSchema), async (c) => {
  // const clientId = c.get('clientId');
  // const body = c.req.valid('json');
  // TODO Sprint 2: wire to accountService.create
  return c.json({ error: 'not implemented' }, 501);
});

accounts.get('/:address', async (c) => {
  // TODO Sprint 2
  return c.json({ error: 'not implemented' }, 501);
});

accounts.put('/:address/signers', async (c) => {
  // TODO Sprint 2
  return c.json({ error: 'not implemented' }, 501);
});

accounts.delete('/:address', async (c) => {
  // TODO Sprint 2
  return c.json({ error: 'not implemented' }, 501);
});

accounts.post('/:address/rotate-key', async (c) => {
  // TODO Sprint 2
  return c.json({ error: 'not implemented' }, 501);
});

export default accounts;
