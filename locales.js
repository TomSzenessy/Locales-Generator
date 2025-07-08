#!/usr/bin/env node

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const { globSync } = require('glob');

// --- CONFIGURATION ---
// Defines constants and paths used throughout the script.
const PORT = 3333; // Port for the web server to run on.
const i18nDir = path.resolve(__dirname, '../src/lib/i18n'); // Base directory for i18n files.
const localesDir = path.join(i18nDir, 'locales'); // Directory where locale JSON files are stored.
const typesFilePath = path.join(i18nDir, 'types.ts'); // Path for the generated TypeScript types file.
const workspaceDir = path.resolve(__dirname, '../src'); // The root directory of the application source code to scan.
const locales = ['en', 'de', 'es', 'fr']; // Supported locales (languages) for the application.
const IGNORE_PATTERNS = [
	'**/node_modules/**', // Ignore node_modules directory.
	'**/dist/**', // Ignore build output directories.
	'**/.next/**', // Ignore Next.js build directory.
	'**/*.d.ts', // Ignore TypeScript declaration files.
	`${i18nDir}/**` // Ignore the i18n directory itself to prevent self-referencing.
];
// ---------------------

// --- UTILITY FUNCTIONS ---

/**
 * Recursively sets a value in a nested object using a path array.
 * @param {object} obj - The object to modify.
 * @param {string[]} pathArr - An array of keys representing the path to the value.
 * @param {*} value - The value to set.
 */
function deepSet(obj, pathArr, value) {
	let current = obj;
	for (let i = 0; i < pathArr.length - 1; i++) {
		const key = pathArr[i];
		if (!current[key] || typeof current[key] !== 'object')
			current[key] = {};
		current = current[key];
	}
	current[pathArr[pathArr.length - 1]] = value;
}

/**
 * Retrieves a value from a nested object using a dot-separated key path.
 * @param {object} obj - The object to query.
 * @param {string} keyPath - The dot-separated path to the desired value (e.g., "common.greeting").
 * @returns {*} The value at the specified path, or undefined if not found.
 */
function getValue(obj, keyPath) {
	return keyPath
		.split('.')
		.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

/**
 * Checks if a string is a valid JavaScript identifier.
 * Used for formatting TypeScript interface keys.
 * @param {string} str - The string to validate.
 * @returns {boolean} True if the string is a valid identifier, false otherwise.
 */
function isValidIdentifier(str) {
	return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str);
}

/**
 * Extracts translation keys from a TypeScript types file content.
 * This function parses the `types.ts` file to get a definitive list of all expected translation keys.
 * @param {string} content - The content of the TypeScript types file.
 * @returns {Set<string>} A set of all extracted translation keys (e.g., "common.greeting").
 */
function getTypeKeys(content) {
	const keys = new Set();
	const stack = []; // Used to keep track of nested object keys
	const lines = content.split('\n');
	for (const line of lines) {
		const trimmedLine = line.trim();
		// If a line ends with '{', it indicates the start of a nested object/interface.
		if (trimmedLine.endsWith('{')) {
			const key = trimmedLine.match(/(\w+):/)?.[1]; // Extract the key name
			if (key) stack.push(key);
		} else if (trimmedLine.startsWith('}')) {
			// If a line starts with '}', it indicates the end of a nested object/interface.
			stack.pop();
		} else if (trimmedLine.includes(': string;')) {
			// If a line contains ': string;', it's a translation key definition.
			const keyMatch = trimmedLine.match(/(\w+|'[^']+'|"[^"]+"): /);
			let key = keyMatch?.[1];
			if (key) {
				key = key.replace(/['"]/g, ''); // Remove quotes from keys like 'my-key'
				const fullPath = [...stack, key].join('.'); // Construct the full dot-separated path
				if (key.match(/^\d+$/)) {
					// Handle numeric keys (e.g., for arrays, though less common in i18n)
					keys.add(stack.join('.'));
				} else {
					keys.add(fullPath);
				}
			}
		}
	}
	return keys;
}

/**
 * Sets a value in a nested object using a dot-separated key path.
 * This is used when saving new translations from the web UI back into the JSON files.
 * @param {object} obj - The object to modify.
 * @param {string} keyPath - The dot-separated path to the value (e.g., "common.greeting").
 * @param {*} value - The value to set.
 */
function setValue(obj, keyPath, value) {
	const keys = keyPath.split('.');
	const lastKey = keys.pop(); // Get the last key in the path
	let current = obj;
	for (const key of keys) {
		// Traverse or create nested objects
		if (!current[key] || typeof current[key] !== 'object')
			current[key] = {};
		current = current[key];
	}
	current[lastKey] = value; // Set the value at the final key
}

// --- CORE LOGIC: STEP 1 - GENERATION ---
// This step identifies all translation keys used in the application's source code
// and generates a TypeScript type definition file based on these keys.

/**
 * Scans the project's source files for all occurrences of the `t()` internationalization function
 * to extract used translation keys.
 * @returns {string[]} A sorted array of unique translation keys found in the project.
 */
function scanForKeys() {
	console.log(`\n🔍 Scanning for t() calls in: ${workspaceDir}`);
	// Regex to find `t('key.path')`, `t("key.path")`, or `t(`key.path`)` calls.
	const i18nRegex =
		/\bt\(\s*(['"`])([a-zA-Z0-9_.-]+(?:\.[a-zA-Z0-9_.-]+)*)\1(?:\s*,\s*(?:[^)]|\([^)]*\))*?)?\s*\)/gs;
	const allKeys = new Set(); // Use a Set to store unique keys.
	// Find all relevant source files (JS, JSX, TS, TSX) in the workspace, ignoring specified patterns.
	const files = globSync('**/*.{js,jsx,ts,tsx}', {
		cwd: workspaceDir,
		ignore: IGNORE_PATTERNS
	});
	console.log(`...found ${files.length} files to scan.`);

	for (const file of files) {
		const filePath = path.join(workspaceDir, file);
		try {
			const content = fsSync.readFileSync(filePath, 'utf-8');
			let match;
			// Execute regex repeatedly to find all matches in the file content.
			while ((match = i18nRegex.exec(content)) !== null) {
				if (match[2]) allKeys.add(match[2]); // Add the extracted key to the set.
			}
		} catch (err) {
			console.warn(`⚠️  Could not read file: ${filePath}`);
		}
	}
	return [...allKeys].sort(); // Convert set to array and sort alphabetically.
}

/**
 * Generates a TypeScript interface file (`types.ts`) based on the scanned translation keys.
 * This file provides type safety for translation keys in the application.
 * @param {string[]} sortedKeys - A sorted array of unique translation keys.
 */
function generateTypesFile(sortedKeys) {
	console.log(
		`\n📝 Generating TypeScript types from ${sortedKeys.length} keys...`
	);
	const tsStructure = {};
	// Build a nested object structure from the dot-separated keys, with 'string' as leaf values.
	for (const key of sortedKeys) {
		deepSet(tsStructure, key.split('.'), 'string');
	}

	/**
	 * Recursively formats a JavaScript object into a TypeScript interface string.
	 * @param {object} obj - The object representing the interface structure.
	 * @param {number} indentLevel - Current indentation level.
	 * @returns {string} The formatted TypeScript interface string.
	 */
	function formatToTsInterface(obj, indentLevel = 1) {
		const indent = '\t'.repeat(indentLevel);
		let result = '';
		for (const [key, value] of Object.entries(obj)) {
			// Format key: enclose in quotes if not a valid identifier (e.g., 'my-key').
			const formattedKey = isValidIdentifier(key) ? key : `'${key}'`;
			if (typeof value === 'object' && value !== null) {
				// If value is an object, recursively format as a nested interface.
				result += `${indent}${formattedKey}: {\n${formatToTsInterface(
					value,
					indentLevel + 1
				)}${indent}};\n`;
			} else {
				// Otherwise, it's a string literal (the translation value).
				result += `${indent}${formattedKey}: ${value};\n`;
			}
		}
		return result;
	}

	const tsInterfaceBody = formatToTsInterface(tsStructure);
	// Assemble the final TypeScript file content.
	const tsFileContent = `export interface LocaleStructure {\n${tsInterfaceBody}}\n`;
	// Write the content to the types.ts file.
	fs.writeFile(typesFilePath, tsFileContent, 'utf-8');
	console.log(`✅ Generated TypeScript types file: ${typesFilePath}`);
}

// --- CORE LOGIC: STEP 2 - CLEANUP ---
// This step removes any translation keys from the locale JSON files that are no longer
// found in the application's source code (as determined by `scanForKeys`).

/**
 * Cleans up locale JSON files by removing translation keys that are no longer used
 * in the application's source code.
 * @param {string[]} validKeys - An array of currently used translation keys.
 */
async function cleanupLocaleFiles(validKeys) {
	console.log('\n🧹 Cleaning up unused keys from locale files...');
	const validKeysSet = new Set(validKeys); // Convert to Set for efficient lookup.
	let totalRemoved = 0;

	// Iterate over each supported locale.
	for (const locale of locales) {
		const filePath = path.join(localesDir, `${locale}.json`);
		try {
			const content = await fs.readFile(filePath, 'utf-8');
			let data = JSON.parse(content); // Parse the JSON content.
			let removedCount = 0;

			/**
			 * Recursively traverses the locale data object and removes unused keys.
			 * @param {object} obj - The current object being traversed.
			 * @param {string[]} path - The current path (array of keys) to the object.
			 */
			function traverseAndClean(obj, path = []) {
				for (const key in obj) {
					if (Object.prototype.hasOwnProperty.call(obj, key)) {
						const currentPath = [...path, key]; // Build the full key path.
						if (typeof obj[key] === 'object' && obj[key] !== null) {
							// If it's a nested object, recurse.
							traverseAndClean(obj[key], currentPath);
							// After cleaning children, if the object is empty, delete it.
							if (Object.keys(obj[key]).length === 0) {
								delete obj[key];
							}
						} else if (!validKeysSet.has(currentPath.join('.'))) {
							// If the key is not in the set of valid keys, delete it.
							delete obj[key];
							removedCount++;
						}
					}
				}
			}

			traverseAndClean(data); // Start cleaning from the root of the locale data.
			if (removedCount > 0) {
				// If keys were removed, write the updated JSON back to the file.
				await fs.writeFile(
					filePath,
					JSON.stringify(data, null, '\t'), // Pretty print with tabs.
					'utf-8'
				);
				console.log(
					`   - Removed ${removedCount} unused keys from ${locale}.json`
				);
				totalRemoved += removedCount;
			}
		} catch (error) {
			console.error(`⚠️ Could not clean ${filePath}:`, error.message);
		}
	}
	if (totalRemoved === 0)
		console.log('   - No unused keys found. All files are clean.');
}

// --- CORE LOGIC: STEP 3 - SYNC (Web UI) ---
// This step identifies missing translations across locale files compared to the generated types,
// and then launches a local web server with an interactive UI to facilitate adding these translations.

/**
 * Compares the keys in the generated `types.ts` file with existing keys in locale JSON files
 * to identify which translation keys are missing in which locales.
 * @returns {Map<string, object>} A Map where keys are translation key paths (e.g., "common.greeting")
 *   and values are objects containing the current translation status for each locale (e.g., { en: "Hello", de: undefined }).
 */
async function getMissingKeys() {
	// Read the content of the TypeScript types file to get the definitive list of all keys.
	const typeContent = await fs.readFile(typesFilePath, 'utf-8');
	const localeData = {};
	// Load content of all locale JSON files into memory.
	for (const locale of locales) {
		const content = await fs.readFile(
			path.join(localesDir, `${locale}.json`),
			'utf-8'
		);
		localeData[locale] = JSON.parse(content);
	}
	const typeKeys = getTypeKeys(typeContent); // Get keys from the types file.
	const missingKeys = new Map(); // Map to store keys that are missing in any locale.

	// Iterate over each key defined in the TypeScript types.
	for (const typeKey of typeKeys) {
		// Check if this key exists in ALL locale files.
		if (
			!locales.every(
				(locale) => getValue(localeData[locale], typeKey) !== undefined
			)
		) {
			// If the key is missing in at least one locale, record its status across all locales.
			const values = {};
			for (const locale of locales) {
				values[locale] = getValue(localeData[locale], typeKey);
			}
			missingKeys.set(typeKey, values);
		}
	}
	return missingKeys;
}

/**
 * Provides the CSS styles for the web interface.
 * @returns {string} CSS string.
 */
const getPageStyles = () => `
    :root { --bg-color: #1a1a1a; --text-color: #e0e0e0; --primary-color: #4e9af1; --border-color: #333; --input-bg: #333; --input-missing-border: #f48c06; --header-bg: #2c2c2c; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: var(--bg-color); color: var(--text-color); margin: 0; padding: 2rem; }
    .container { max-width: 1400px; margin: auto; }
    h1, h2 { color: var(--primary-color); border-bottom: 2px solid var(--primary-color); padding-bottom: 10px; }
    .message { padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
    .message.success { background-color: #2a4; color: #fff; }
    .message.info { background-color: #246; color: #fff; }
    .section { background-color: #252525; padding: 1.5rem; border-radius: 8px; margin-top: 2rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 14px; }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid var(--border-color); }
    th { background-color: var(--header-bg); position: sticky; top: 0; }
    tr:hover { background-color: #282828; }
    label { font-family: monospace; }
    input[type="text"] { width: 95%; padding: 8px; border: 1px solid #555; background-color: var(--input-bg); color: var(--text-color); border-radius: 4px; transition: all 0.2s; }
    input.missing { border-color: var(--input-missing-border); }
    input.missing:focus { outline: none; border-color: #f5a133; box-shadow: 0 0 5px #f5a13344; }
    input.existing { background-color: #222; color: #888; border-color: #444; cursor: not-allowed; }
    button, .button { display: inline-block; background-color: var(--primary-color); color: white; padding: 10px 18px; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; transition: background-color 0.2s; text-decoration: none; margin-right: 10px; }
    button:hover, .button:hover { background-color: #3a7ac8; }
    .actions { margin-top: 20px; }
    textarea { width: 100%; min-height: 150px; background-color: var(--input-bg); color: var(--text-color); border: 1px solid #555; border-radius: 5px; padding: 10px; font-family: monospace; margin-top: 10px; box-sizing: border-box; }
    .prompt-box { background-color: #2c2c2c; border: 1px solid #444; padding: 1rem; border-radius: 5px; white-space: pre-wrap; font-family: monospace; margin-top: 1rem; max-height: 300px; overflow-y: auto; }
`;

/**
 * Provides the client-side JavaScript for the web interface.
 * This script handles CSV generation, AI prompt creation, and auto-filling the translation table.
 * @param {string} missingKeysJson - JSON string of missing keys data.
 * @param {string} localesJson - JSON string of supported locales.
 * @returns {string} JavaScript string.
 */
const getClientScript = (missingKeysJson, localesJson) => `
    const missingKeysData = ${missingKeysJson};
    const locales = ${localesJson};
    // Helper to escape CSV cell values.
    function escapeCsvCell(cell) { const str = String(cell || ''); if (str.includes(',') || str.includes('"') || str.includes('\\n')) { return '"' + str.replace(/"/g, '""') + '"'; } return str; }
    // Generates a CSV string from the missing keys data.
    function generateCsv() { const header = ['key', ...locales].map(escapeCsvCell).join(','); const rows = missingKeysData.map(item => { const row = [item.key, ...locales.map(l => item[l] || '')]; return row.map(escapeCsvCell).join(','); }); return [header, ...rows].join('\\n'); }
    // Generates a prompt for an AI translation model, including the CSV data.
    function generateAIPrompt() { const csvData = generateCsv(); const targetLocales = locales.filter(l => l !== 'en').map(l => \`\${l}\`).join(', '); return \`You are an expert translator for a web application. I will provide a table of translation keys in CSV format.\\nThe 'key' column must not be changed.\\nThe 'en' column usually contains the source text in English, otherwise you will have to derive the meaning from the key or the other languages columns 'de', 'es' and 'fr' if given.\\n\\nYour task is to translate the text into the following languages and fill in all of their respective columns: \${targetLocales}.\\nIf a value already exists in a target language column, you can use it as context, but prioritize translating from the English 'en' column.\\nPlease provide the response as a single, complete CSV block including the header.\\n\\nHere is the data:\\n\\\`\\\`\\\`csv\\n\${csvData}\\n\\\`\\\`\\\`\`; }
    // Event listener for copying the AI prompt.
    document.getElementById('copy-ai-prompt')?.addEventListener('click', () => { const promptText = generateAIPrompt(); navigator.clipboard.writeText(promptText).then(() => { const previewBox = document.getElementById('ai-prompt-preview'); const container = document.getElementById('ai-prompt-container'); previewBox.textContent = promptText; container.style.display = 'block'; alert('AI prompt and data copied to clipboard!'); }).catch(err => alert('Failed to copy: ' + err)); });
    // Event listener for auto-filling the table from pasted CSV data.
    document.getElementById('autofill-btn')?.addEventListener('click', () => { const pasteData = document.getElementById('import-area').value.trim(); if (!pasteData) { alert('Please paste data into the text area first.'); return; } fillTableFromCsv(pasteData); });
    // Fills the translation table with data from a parsed object.
    function fillTableFromData(data) { let filledCount = 0; data.forEach(item => { const row = document.querySelector(\`tr[data-key="\${item.key}"]\`); if (row) { locales.forEach(loc => { const input = row.querySelector(\`input[name="\${item.key}|\${loc}"]\`); if (input && !input.readOnly && item[loc]) { input.value = item[loc]; filledCount++; } }); } }); alert(\`Auto-filled \${filledCount} translations! Please review and save.\`); }
    // Parses CSV data and fills the translation table.
    function fillTableFromCsv(csvData) { csvData = csvData.replace(/^\\\`\\\`\\\`csv\\n/,'').replace(/\\n\\\`\\\`\\\`$/,'').trim(); const lines = csvData.split(/\\r?\\n/).filter(line => line.trim() !== ''); if (lines.length < 2) { alert('Invalid CSV data. Requires at least a header and one data row.'); return; } const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '')); const keyIndex = header.indexOf('key'); if (keyIndex === -1) { alert('Invalid CSV header. Must contain a "key" column.'); return; } const data = lines.slice(1).map(line => { const values = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.trim().replace(/^"|"$/g, '').replace(/""/g, '"')); const item = {}; item.key = values[keyIndex]; header.forEach((colName, index) => { if (locales.includes(colName)) { item[colName] = values[index]; } }); return item; }); fillTableFromData(data); }
`;

/**
 * Generates the full HTML content for the web interface.
 * This includes the structure, styles, and client-side script for the translation sync tool.
 * @param {Map<string, object>} missingKeys - A Map of missing translation keys and their current values.
 * @returns {string} The complete HTML string for the web page.
 */
function generateHtml(missingKeys) {
	const missingKeysArray = Array.from(missingKeys.entries());
	const missingKeysJson = JSON.stringify(
		missingKeysArray.map(([key, values]) => ({ key, ...values }))
	);
	let tableRows = '';
	// Generate table rows for each missing key, with input fields for each locale.
	missingKeysArray.forEach(([key, values], i) => {
		tableRows += `<tr data-key="${key}"><td><label for="key-${i}-en">${key}</label></td>${locales
			.map(
				(l) =>
					`<td><input type="text" id="key-${i}-${l}" name="${key}|${l}" value="${
						values[l] || ''
					}" ${values[l] ? 'readonly' : ''} class="${
						values[l] ? 'existing' : 'missing'
					}" placeholder="${
						values[l] ? '' : 'Translate here...'
					}"/></td>`
			)
			.join('')}</tr>`;
	});
	// Determine the main body content based on whether there are missing keys.
	const bodyContent =
		missingKeys.size === 0
			? `<div class="message success">✅ All locale files are up-to-date!</div>`
			: `<div class="message info">${
					missingKeys.size
			  } keys need translations.</div><div class="section"><h2>1. Generate AI Prompt & Data</h2><p>Click the button below to copy a complete prompt with all the missing translation data. Paste this directly into your AI chat model.</p><div class="actions"><button id="copy-ai-prompt" type="button">Copy Full Prompt for AI</button></div><div id="ai-prompt-container" style="display:none;"><h3>Preview of the copied prompt:</h3><div id="ai-prompt-preview" class="prompt-box"></div></div></div><div class="section"><h2>2. Import Translated Data</h2><p>After the AI translates the data, paste the entire CSV block (including the header) that it provides into the text area below and click "Auto-fill Table".</p><textarea id="import-area" placeholder="Paste your translated CSV data here..."></textarea><div class="actions"><button type="button" id="autofill-btn">Auto-fill Table from Pasted Data</button></div></div><div class="section"><h2>3. Review and Save</h2><p>Review the auto-filled translations in the table below. Make any manual corrections if needed, then click save.</p><form action="/save" method="post"><table id="sync-table"><thead><tr><th>Key Path</th>${locales
					.map((l) => `<th>${l.toUpperCase()}</th>`)
					.join(
						''
					)}</tr></thead><tbody>${tableRows}</tbody></table><div class="actions"><button type="submit">Save All Translations</button></div></form></div>`;
	// Return the complete HTML document.
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>i18n Sync Tool</title><style>${getPageStyles()}</style></head><body><div class="container">${bodyContent}</div><script>${getClientScript(
		missingKeysJson,
		JSON.stringify(locales)
	)}</script></body></html>`;
}

/**
 * Starts a local web server to host the i18n sync tool UI.
 * This server handles displaying the translation status and saving updated translations.
 */
async function startServer() {
	const app = express(); // Initialize Express application.
	const server = http.createServer(app); // Create HTTP server.
	app.use(bodyParser.urlencoded({ extended: true })); // Middleware to parse URL-encoded bodies (for form submissions).

	// Route for the main page (GET /).
	app.get('/', async (req, res) => {
		try {
			const missingKeys = await getMissingKeys(); // Get current missing keys.
			const html = generateHtml(missingKeys); // Generate HTML for the page.
			res.send(html); // Send the HTML response.
		} catch (error) {
			console.error('Error generating page:', error);
			res.status(500).send(
				'<h1>Error</h1><p>Could not process i18n files. Check console for details.</p>'
			);
		}
	});

	// Route for saving translations (POST /save).
	app.post('/save', async (req, res) => {
		try {
			const localeData = {};
			// Load current locale data from files.
			for (const locale of locales) {
				const content = await fs.readFile(
					path.join(localesDir, `${locale}.json`),
					'utf-8'
				);
				localeData[locale] = JSON.parse(content);
			}
			// Iterate over submitted form data and update localeData.
			for (const [formKey, value] of Object.entries(req.body)) {
				if (value) {
					const [keyPath, locale] = formKey.split('|'); // Extract key path and locale from form field name.
					setValue(localeData[locale], keyPath, value); // Set the new translation value.
				}
			}
			// Write updated locale data back to respective JSON files.
			for (const locale of locales) {
				const newContent = JSON.stringify(
					localeData[locale],
					null,
					'\t'
				); // Pretty print.
				await fs.writeFile(
					path.join(localesDir, `${locale}.json`),
					newContent,
					'utf-8'
				);
			}
			console.log('✅ All files synchronized successfully!');
			// Send success response and redirect back to the main page after a short delay.
			res.send(
				`<!DOCTYPE html><html><head><title>Success</title><style>body { font-family: sans-serif; background: #1a1a1a; color: #e0e0e0; display: grid; place-content: center; height: 100vh; text-align: center; } a { color: #4e9af1; }</style></head><body><h1>✅ Success!</h1><p>All translation files have been updated.</p><a href="/">Go back to the tool</a><script>setTimeout(() => window.location.href = '/', 1500);</script></body></html>`
			);
		} catch (error) {
			console.error('Error saving files:', error);
			res.status(500).send(
				'<h1>Error</h1><p>Could not save i18n files. Check console for details.</p>'
			);
		}
	});

	// Start the server and log the access URL.
	server.listen(PORT, () => {
		console.log(`\n✅ Web server is running!`);
		console.log(
			`🌍 Open your browser and navigate to: http://localhost:${PORT}`
		);
		console.log(`\nPress CTRL+C to stop the server.`);
	});
}

// --- Main Execution Flow ---
// This is the primary function that orchestrates the entire i18n process.
async function run() {
	console.log('🚀 Starting i18n Tool...');

	// Step 1: Scan the entire project to find all translation keys currently in use.
	const usedKeys = scanForKeys();
	if (usedKeys.length === 0) {
		console.log('✅ No translation keys found in the project. Exiting.');
		return;
	}

	// Step 2: Generate or update the TypeScript types file (`types.ts`) based on the `usedKeys`.
	// This ensures type safety and autocompletion for translation keys in the codebase.
	generateTypesFile(usedKeys);

	// Step 3: Remove any translation keys from the locale JSON files that are no longer
	// present in the `usedKeys` list, keeping the locale files clean and optimized.
	await cleanupLocaleFiles(usedKeys);

	// Step 4: Launch a local web server that provides an interactive user interface.
	// This UI allows developers to easily identify and add missing translations,
	// and can even generate prompts for AI translation services.
	console.log('\n🚀 Launching web interface for the final sync step...');
	await startServer();
}

// Execute the main `run` function and catch any unhandled errors.
run().catch((error) => {
	console.error('\n❌ An unexpected error occurred:', error);
	process.exit(1); // Exit the process with an error code.
});
