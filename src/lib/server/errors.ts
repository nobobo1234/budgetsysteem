/** Invoer die de server weigert; de melding is in gewone taal en mag naar de gebruiker. */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ValidationError';
	}
}
