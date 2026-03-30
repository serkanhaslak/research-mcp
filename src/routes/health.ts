import { Hono } from 'hono';
import type { Env } from '../env.js';

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: new Date().toISOString() })
);
