import { Router } from 'express';
import type { ReadinessService } from './readiness.service.js';

/**
 * /health/live  - process is up (no dependency calls; used for restarts)
 * /health/ready - dependencies reachable (cached; used for traffic routing)
 * /health       - summary for humans and dashboards
 */
export function createHealthRouter(readiness: ReadinessService, version: string): Router {
  const router = Router();

  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/health/ready', async (_req, res) => {
    const report = await readiness.report();
    res.status(report.ready ? 200 : 503).json({
      status: report.ready ? 'ready' : 'not_ready',
      ...report,
    });
  });

  router.get('/health', async (_req, res) => {
    const report = await readiness.report();
    res.status(report.ready ? 200 : 503).json({
      status: report.ready ? 'ok' : 'degraded',
      version,
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: report.dependencies,
    });
  });

  return router;
}
