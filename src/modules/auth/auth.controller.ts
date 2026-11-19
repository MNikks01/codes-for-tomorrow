import type { Request, Response } from 'express';
import { sendSuccess } from '../../shared/http/response.js';
import { parseInput } from '../../shared/validation/parse.js';
import { loginBodySchema, refreshBodySchema, registerBodySchema } from './auth.schema.js';
import type { AuthService } from './auth.service.js';

export class AuthController {
  constructor(private readonly auth: AuthService) {}

  register = async (req: Request, res: Response): Promise<void> => {
    const body = parseInput(registerBodySchema, req.body, 'body');
    sendSuccess(res, await this.auth.register(body), { status: 201 });
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const body = parseInput(loginBodySchema, req.body, 'body');
    sendSuccess(res, await this.auth.login(body));
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = parseInput(refreshBodySchema, req.body, 'body');
    sendSuccess(res, { tokens: await this.auth.refresh(refreshToken) });
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = parseInput(refreshBodySchema, req.body, 'body');
    await this.auth.logout(refreshToken);
    res.status(204).end();
  };
}
