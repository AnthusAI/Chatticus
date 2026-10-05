import type { Hono } from "hono";

/**
 * The intended audience for a route: who is permitted to call it.
 */
export type RouteAudience = "public" | "user" | "operator" | "worker" | "integration";

/**
 * Metadata about a registered route: method, path, and intended audience.
 */
export interface RouteRegistration {
	method: string;
	path: string;
	audience: RouteAudience;
}

/**
 * Tracks all routes registered through declareRoute.
 * Used to enforce that every route has a declared audience.
 */
const registeredRoutes: RouteRegistration[] = [];

/**
 * Register a route with Hono and track its audience declaration.
 * Every route except /health must declare which audience it serves.
 *
 * @param app The Hono application
 * @param route The route metadata (method, path, audience)
 * @param handler The request handler
 */
export function declareRoute(
	app: Hono,
	route: { method: string; path: string; audience: RouteAudience },
	handler: (c: any) => any,
): void {
	registeredRoutes.push({
		method: route.method,
		path: route.path,
		audience: route.audience,
	});

	const method = route.method.toLowerCase();
	if (method === "get") {
		app.get(route.path, handler);
	} else if (method === "post") {
		app.post(route.path, handler);
	} else if (method === "put") {
		app.put(route.path, handler);
	} else if (method === "patch") {
		app.patch(route.path, handler);
	} else if (method === "delete") {
		app.delete(route.path, handler);
	} else {
		throw new Error(`Unsupported HTTP method: ${method}`);
	}
}

/**
 * Return all registered routes for testing.
 */
export function getRegisteredRoutes(): RouteRegistration[] {
	return [...registeredRoutes];
}

/**
 * Clear all registered routes (used in tests).
 */
export function clearRegisteredRoutes(): void {
	registeredRoutes.length = 0;
}
