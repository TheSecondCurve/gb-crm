import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginSchema>;

export const PASSWORD_MIN_LENGTH = 8;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH),
});
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;
