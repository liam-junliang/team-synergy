import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.ACP_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/acp',
  },
});
