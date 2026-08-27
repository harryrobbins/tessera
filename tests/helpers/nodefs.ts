/**
 * Node's fs/path/url for the tests that check committed assets. Kept behind
 * one helper so browser-side test files import a single, obviously node-only
 * module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { fs, path };
export const testsDir = path.dirname(fileURLToPath(import.meta.url));
