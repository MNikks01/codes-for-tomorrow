import { NotFoundError } from '../../shared/errors/app-error.js';
import { toPublicUser, type PublicUser, type UserRepository } from './user.types.js';

export class UserService {
  constructor(private readonly users: Pick<UserRepository, 'findById'>) {}

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User');
    return toPublicUser(user);
  }
}
