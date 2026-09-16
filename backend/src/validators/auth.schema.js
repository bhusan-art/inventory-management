import { z } from 'zod';

/**
 * Password policy. Length carries most of the strength here; a 12-character
 * minimum with a common-password check beats a short password with four
 * character-class rules, which mostly produces "Password1!".
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '123456789', 'qwerty123',
  'admin@123', 'welcome123', 'changeme123', 'letmein123', 'inventory123',
]);

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'That password is too common')
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), 'Password must contain letters and numbers');

export const loginSchema = {
  body: z.object({
    email: z.string().trim().toLowerCase().email('A valid email address is required'),
    password: z.string().min(1, 'Password is required').max(128),
  }),
};

export const changePasswordSchema = {
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: passwordSchema,
  }),
};

export const forgotPasswordSchema = {
  body: z.object({
    email: z.string().trim().toLowerCase().email('A valid email address is required'),
  }),
};

export const resetPasswordSchema = {
  body: z.object({
    token: z.string().min(20, 'Invalid reset token'),
    newPassword: passwordSchema,
  }),
};
