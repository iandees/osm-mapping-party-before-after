import { applyD1Migrations, env } from "cloudflare:test";

// Apply D1 migrations once before the test suite runs.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
