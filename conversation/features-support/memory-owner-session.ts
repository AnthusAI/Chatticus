import { withoutAbortSignal } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import type { OwnerSession, OwnerSessionFactory } from "../src/pi/session.ts";

/** A test-only owner session backed by Pi's in-memory storage. */

export function memoryOwnerSessionFactory(
	onOpen?: (session: OwnerSession, storageId: string) => void,
): OwnerSessionFactory {
	return async (storageId, dependencies) => {
		const storage = new MemoryStorage();
		const harnessStorage = new Proxy(storage, {
			get(target, property) {
				if (property === "close") return async () => undefined;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Storage;
		const registry = createRegistry();
		for (const extension of dependencies.extensions) registry.install(extension);
		const harness = await Harness.open(
			harnessStorage,
			{ models: dependencies.models, registry, settings: dependencies.settings, env: dependencies.env },
			dependencies.context,
		);
		const session = {
			harness,
			storage,
			fence: 1,
			close: () => harness.close(withoutAbortSignal(dependencies.context)),
		};
		onOpen?.(session, storageId);
		return session;
	};
}
