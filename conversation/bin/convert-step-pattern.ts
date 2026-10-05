#!/usr/bin/env node

/**
 * Convert Python behave parse patterns to Cucumber expressions.
 *
 * Patterns:
 * - {name} in quotes -> {string}
 * - {name:d} -> {int}
 * - bare {name} -> {word}
 *
 * Usage: npx tsx bin/convert-step-pattern.ts '<pattern>'
 */

const pattern = process.argv[2];

if (!pattern) {
	console.error("Usage: npx tsx bin/convert-step-pattern.ts '<pattern>'");
	process.exit(1);
}

function convertPattern(input: string): string {
	let result = input;

	result = result.replace(/"{([^:}]+)}"/g, "{string}");
	result = result.replace(/{([^:}]+):d}/g, "{int}");
	result = result.replace(/{([^:}]+)}/g, "{word}");

	return result;
}

const cucumberExpression = convertPattern(pattern);
console.log(cucumberExpression);
