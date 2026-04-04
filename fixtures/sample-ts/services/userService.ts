import { User } from '../models/user';

export class UserService {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }

  findByName(name: string): User | undefined {
    return this.users.find(u => u.name === name);
  }
}
