import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('app wiring', () => {
  const app = createApp();

  it('serves liveness without touching the database', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('reports not-ready when the database is unavailable', async () => {
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.data.checks.transactions.status).toBe('unavailable');
  });

  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, errors: [] });
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
