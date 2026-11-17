// Types of error-codes.mjs (test/codes.test.ts imports its pure functions).
export declare const BEGIN: string;
export declare const END: string;
export declare function readCatalog(source: string): { group: string; code: string; text: string }[];
export declare function renderCodes(catalog: { group: string; code: string; text: string }[]): string;
export function renderNames(catalog: { group: string; code: string; text: string }[]): string;
