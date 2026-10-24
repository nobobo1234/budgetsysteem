import type { Session } from '#lib/server/auth/session.ts';

declare global {
	namespace App {
		interface Error {
			errorId?: string;
		}
		interface Locals {
			session: Session | null;
		}
	}
}

export {};
