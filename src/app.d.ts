import type { Session } from '#lib/server/auth/session.ts';
import type { UploadToken } from '#lib/server/receipts/tokens.ts';

declare global {
	namespace App {
		interface Error {
			errorId?: string;
		}
		interface Locals {
			session: Session | null;
			/** Alleen op `/api/ingest`: het upload-token waarmee de bon binnenkomt */
			uploadToken?: UploadToken | null;
		}
	}
}

export {};
