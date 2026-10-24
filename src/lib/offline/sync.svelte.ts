import { pending, type OutboxItem } from './queue.ts';

/** Gedeelde status van de offline wachtrij, voor de banner en de lijst met recente invoer. */
class SyncState {
	offline = $state(false);
	loggedOut = $state(false);
	pending = $state.raw<OutboxItem[]>([]);

	async refreshPending(): Promise<void> {
		try {
			this.pending = await pending();
		} catch {
			// IndexedDB niet beschikbaar (bijvoorbeeld privévenster): dan is er ook niets in de wachtrij
			this.pending = [];
		}
	}
}

export const sync = new SyncState();
