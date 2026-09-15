import mongoose from 'mongoose';
import { isReplicaSetVerified } from '../config/db.js';
import { ok } from '../utils/response.js';
import asyncHandler from '../utils/asyncHandler.js';

const CONNECTION_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

/** Liveness — is the process up. Deliberately does not touch the database. */
export const live = (req, res) => ok(res, { message: 'alive', data: { uptime: process.uptime() } });

/**
 * Readiness — can this instance actually serve traffic.
 *
 * Reports replica set status explicitly, because "database connected" is not
 * sufficient here: a connected standalone mongod cannot run the transactions
 * this system requires, and an orchestrator should not route traffic to an
 * instance in that state.
 */
export const ready = asyncHandler(async (req, res) => {
  const state = CONNECTION_STATES[mongoose.connection.readyState] ?? 'unknown';
  const dbConnected = mongoose.connection.readyState === 1;
  const transactionsAvailable = dbConnected && isReplicaSetVerified();

  const checks = {
    database: { status: dbConnected ? 'up' : 'down', state },
    transactions: { status: transactionsAvailable ? 'available' : 'unavailable' },
  };

  const healthy = dbConnected && transactionsAvailable;
  return res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy ? 'ready' : 'not ready',
    data: { checks, version: process.env.npm_package_version ?? '0.1.0' },
  });
});
