import type { Session } from '#lib/server/auth/session.ts';
import type { UploadToken } from '#lib/server/receipts/tokens.ts';
import type { EntryKind } from '#lib/usage.ts';

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

	interface WindowEventMap {
		/** Een invoer is opgeslagen; telt voor je eigen gebruik (zie usage.ts) */
		invoer: CustomEvent<EntryKind>;
	}
}

export {};
