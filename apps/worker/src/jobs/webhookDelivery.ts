// Webhook delivery worker. HMAC-SHA256 signs the payload, POSTs to the
// endpoint, retries with exponential backoff on failure.
// See PLAN.md §4.4. Header: X-RailForge-Signature.
// TODO Sprint 3.

export {};
