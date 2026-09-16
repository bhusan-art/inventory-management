import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as controller from '../../controllers/auth.controller.js';
import authenticate from '../../middleware/authenticate.js';
import validate from '../../middleware/validate.js';
import env from '../../config/env.js';
import {
  loginSchema, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema,
} from '../../validators/auth.schema.js';

const router = Router();

/**
 * Credential endpoints are rate limited far more tightly than the global
 * ceiling. The threat here is credential stuffing — thousands of attempts
 * across many accounts — which sits well inside a 300/min general limit.
 */
const credentialLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.isTest ? 100_000 : 5,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Try again shortly.', errors: [{ code: 'RATE_LIMITED' }] },
});

router.post('/login', credentialLimiter, validate(loginSchema), controller.login);
router.post('/refresh', controller.refresh);
router.post('/logout', controller.logout);
router.post('/forgot-password', credentialLimiter, validate(forgotPasswordSchema), controller.forgotPassword);
router.post('/reset-password', credentialLimiter, validate(resetPasswordSchema), controller.resetPassword);

router.use(authenticate);

router.get('/me', controller.me);
router.post('/logout-all', controller.logoutAll);
router.post('/change-password', validate(changePasswordSchema), controller.changePassword);

export default router;
