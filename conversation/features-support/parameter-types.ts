import { defineParameterType } from "@cucumber/cucumber";

/**
 * Custom parameter type {text} matches unquoted free text.
 * Matches one or more characters of any kind.
 */
defineParameterType({
	name: "text",
	regexp: /.+/,
	transformer: (s: string) => s,
});
