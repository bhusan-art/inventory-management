import { Router } from 'express';
import * as controller from '../../controllers/auth.controller.js';
import authenticate from '../../middleware/authenticate.js';
import validate from '../../middleware/validate.js';
import { credentialLimiter as makeCredentialLimiter } from '../../middleware/rateLimit.js';
import {
  loginSchema, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema,
} from '../../validators/auth.schema.js';

const router = Router();

const credentialLimiter = makeCredentialLimiter();

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
