import { Hono } from 'hono';

// Credential service routes. See PLAN.md §4.3 / ARCHITECTURE.md §4.3.
// XLS-70. RailForge is NEVER the credential issuer — it brokers a marketplace.
// TODO Sprint 5.

const credentials = new Hono();

credentials.post('/', (c) => c.json({ error: 'not implemented' }, 501));
credentials.get('/:id', (c) => c.json({ error: 'not implemented' }, 501));
credentials.delete('/:id', (c) => c.json({ error: 'not implemented' }, 501));
credentials.post('/verify', (c) => c.json({ error: 'not implemented' }, 501));
credentials.get('/issuers', (c) => c.json({ error: 'not implemented' }, 501));

export default credentials;
