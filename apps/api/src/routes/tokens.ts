import { Hono } from 'hono';

// Token service routes. See PLAN.md §4.2 / ARCHITECTURE.md §4.2.
// MPT default; trust lines via explicit `"type": "trustline"`.
// TODO Sprint 2.

const tokens = new Hono();

tokens.post('/', (c) => c.json({ error: 'not implemented' }, 501));
tokens.get('/:id', (c) => c.json({ error: 'not implemented' }, 501));
tokens.post('/:id/transfer', (c) => c.json({ error: 'not implemented' }, 501));
tokens.put('/:id/freeze', (c) => c.json({ error: 'not implemented' }, 501));
tokens.put('/:id/clawback', (c) => c.json({ error: 'not implemented' }, 501));

export default tokens;
