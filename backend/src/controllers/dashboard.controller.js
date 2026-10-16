import asyncHandler from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import * as dashboardService from '../services/dashboard/dashboardService.js';

export const getDashboard = asyncHandler(async (req, res) => {
  const data = await dashboardService.buildDashboard(req.actor);
  return ok(res, { data });
});

export const getAttentionList = asyncHandler(async (req, res) => {
  const items = await dashboardService.buildAttentionList(req.actor);
  return ok(res, { data: items });
});
