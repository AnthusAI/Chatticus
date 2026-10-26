/** One address that must not be mailed again by one binding. */
export interface RecipientSuppression {
	readonly tenantId: string;
	readonly bindingId: string;
	readonly address: string;
	readonly reason: string;
	readonly suppressedAt: Date;
}

/** The addresses a binding must never mail again, after a permanent bounce or a complaint. */
export interface RecipientSuppressionList {
	/** Whether the address is suppressed for the binding; the address is compared normalized. */
	isSuppressed(tenantId: string, bindingId: string, address: string): Promise<boolean>;
	/** Suppress the address for the binding; suppressing it again changes nothing. */
	suppress(suppression: RecipientSuppression): Promise<void>;
}
