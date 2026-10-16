import { Router } from 'express';
import authenticate from '../../middleware/authenticate.js';
import * as controller from '../../controllers/dashboard.controller.js';

/**
 * The dashboard needs no permission of its own.
 *
 * Every panel is gated individually inside the service, so an actor simply
 * receives the panels they are entitled to. Requiring a blanket
 * VIEW_DASHBOARD would be a second, weaker gate that could disagree with the
 * real ones — and the first time the two disagreed, one of them would be
 * leaking.
 */
export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

dashboardRouter.get('/', controller.getDashboard);
dashboardRouter.get('/attention', controller.getAttentionList);

export default dashboardRouter;
