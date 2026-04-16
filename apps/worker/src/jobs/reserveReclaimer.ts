// Reclaims XRP reserves from accounts marked deleted_at. Pre-XLS-68
// fallback for the reserve sponsor service. See ARCHITECTURE.md §4.7.
//
// BLOCKED on XLS-68 (Sponsored Reserves) amendment activation. Tracked
// as PLAN.md §9.2 gap G-7. Until the amendment lands, the treasury-
// pre-funding model in account.service.ts covers the reserve path; this
// reclaimer will iterate deleted_at rows and issue AccountDelete txs
// once the amendment gives us an on-chain primitive to build against.

export {};
