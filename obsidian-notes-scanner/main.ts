import { App, ItemView, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from 'obsidian';

// Conditionally import Node.js modules only on desktop
let spawn: any;
let path: any;

if (Platform.isDesktop) {
	const childProcess = require('child_process');
	spawn = childProcess.spawn;
	path = require('path');
}

const VIEW_TYPE_NOTE_SCANNER = 'note-scanner-view';

interface ClaudeCodePluginSettings {
	vaultPath: string;
	claudeCodePath: string;
	useAI: boolean;
	excludedFolders: string[];
	prioritizedFolders: string[];
	autoCloseDelay: number;
}

const DEFAULT_SETTINGS: ClaudeCodePluginSettings = {
	vaultPath: '~/Documents/Obsidian/Kry',
	claudeCodePath: '~/.nvm/versions/node/v20.15.1/bin/claude',
	useAI: false,
	excludedFolders: ['archive', '.obsidian', 'Bookmarks', 'attachments', 'Templates', 'Examples', 'src', '1-1'],
	prioritizedFolders: ['/', 'Notes'],
	autoCloseDelay: 10000
}

let closeTimer: number | null = null;
const startCloseTimer = (delay: number, action?: () => void) => {
  closeTimer = window.setTimeout(() => {
    closeTimer = null;
	if (action) {
		action();
	}
  }, delay);
};

const cancelCloseTimer = () => {
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
};

export default class ClaudeCodePlugin extends Plugin {
	settings: ClaudeCodePluginSettings;

	async onload() {
		await this.loadSettings();

		// Force AI off on mobile platforms
		if (Platform.isMobile && this.settings.useAI) {
			this.settings.useAI = false;
			await this.saveSettings();
		}

		// Register the custom view
		this.registerView(
			VIEW_TYPE_NOTE_SCANNER,
			(leaf) => new NoteScannerView(leaf, this)
		);

		// Add ribbon icon to activate view
		this.addRibbonIcon('search', 'Note Scanner', () => {
			this.activateView();
		});

		// Add command to open the sidebar view
		this.addCommand({
			id: 'open-note-scanner-view',
			name: 'Open Note Scanner',
			callback: () => {
				this.activateView();
			}
		});

		// Add settings tab
		this.addSettingTab(new ClaudeCodeSettingTab(this.app, this));
	}

	async onunload() {
		// Detach all leaves of this view type
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_NOTE_SCANNER);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_NOTE_SCANNER);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf in the right sidebar
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_NOTE_SCANNER, active: true });
			}
		}

		// Reveal the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);

			// Focus the input field after revealing
			const view = leaf.view;
			if (view instanceof NoteScannerView) {
				view.inputEl.focus();
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Convert [[FileName]] wiki links and markdown links to clickable HTML links
	convertWikiLinksToHTML(text: string): string {
		// Remove embedded icon images like ![icon](attachments/icons/...)
		text = text.replace(/!\[icon]\([^)]*\)?/g, '').replace(/\s+/g, ' ').trim();

		// First, handle wiki links with aliases: [[path/to/file|alias]]
		text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_match, filePath, alias) => {
			return `<a href="#" class="internal-link" data-file="${filePath.trim()}">${alias.trim()}</a>`;
		});

		// Then, handle simple wiki links: [[FileName]]
		text = text.replace(/\[\[([^\]]+)\]\]/g, (_match, fileName) => {
			return `<a href="#" class="internal-link" data-file="${fileName}">${fileName}</a>`;
		});

		// Handle markdown links with embedded images first: [text ![alt](path)](url)
		text = text.replace(/\[([^[]*?)!\[[^\]]*\]\([^)]*\)\]\(([^)]+)\)/g, (_match, linkText, url) => {
			const cleanLinkText = linkText.trim();

			// Check if it's an external URL
			if (url.startsWith('http://') || url.startsWith('https://')) {
				return `<a href="${url}" class="external-link" target="_blank" rel="noopener">${cleanLinkText}</a>`;
			}
			// Otherwise treat it as an internal link
			return `<a href="#" class="internal-link" data-file="${url}">${cleanLinkText}</a>`;
		});

		// Finally, handle regular markdown links: [text](url)
		text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
			// Check if it's an external URL
			if (url.startsWith('http://') || url.startsWith('https://')) {
				return `<a href="${url}" class="external-link" target="_blank" rel="noopener">${linkText}</a>`;
			}
			// Otherwise treat it as an internal link
			return `<a href="#" class="internal-link" data-file="${url}">${linkText}</a>`;
		});

		text = text.replace(/\[(x|X| )\]/g, '');

		if (!text.includes('<a href=')) {
			text = text.replace(/^(-?\s*)(.+?):?\s*(https?:\/\/[^\s]+)/, (_, prefix, linkText, url) => {
				const linkTextCleaned = linkText.replace(/[\[\]\(\)]/g, '').trim();
				if (prefix.trim() === '-') {
					return `- <a href="${url}" class="external-link" target="_blank" rel="noopener">${linkTextCleaned}</a>`;
				}
				return `- <a href="${url}" class="external-link" target="_blank" rel="noopener">${linkTextCleaned}</a>`;
			});
		}

		return text;
	}

	// Get folder priority index for sorting
	getFolderPriority(filePath: string): number {
		// Extract the folder path from the file path
		const folderPath = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';

		// Find the index in prioritizedFolders array
		const priorityIndex = this.settings.prioritizedFolders.findIndex(folder => {
			// Empty string, '/', 'root', or 'Root' represents root folder
			const folderLower = folder.toLowerCase();
			if (folder === '' || folder === '/' || folderLower === 'root') {
				return folderPath === '';
			}
			// Check if file is directly in the prioritized folder or a subfolder
			return filePath.startsWith(folder + '/') || folderPath === folder;
		});

		// Return the index if found, otherwise return a large number for lowest priority
		return priorityIndex === -1 ? 9999 : priorityIndex;
	}

	// Perform fuzzy search on vault contents
	async fuzzySearch(query: string, currentFileOnly: boolean = false, currentFilePath?: string): Promise<string> {
		let files = this.app.vault.getMarkdownFiles();

		// If searching current file only, filter to just that file
		if (currentFileOnly && currentFilePath) {
			files = files.filter(file => file.path === currentFilePath);
			if (files.length === 0) {
				return 'Current file not found or is not a markdown file.';
			}
		}

		const results: Array<{file: string, filePath: string, line: string, lineNumber: number, mtime: number}> = [];
		const searchTerms = query.toLowerCase().split(' ').filter(term => term.length > 0);

		for (const file of files) {
			// Skip files in excluded folders (unless searching current file only)
			if (!currentFileOnly) {
				const isExcluded = this.settings.excludedFolders.some(folder =>
					file.path.startsWith(folder + '/') || file.path === folder
				);
				if (isExcluded) {
					continue;
				}
			}

			// Check if file name matches search terms
			const fileNameLower = file.basename.toLowerCase();
			const filePathLower = file.path.toLowerCase();
			const fileNameMatches = searchTerms.every(term =>
				fileNameLower.includes(term) || filePathLower.includes(term)
			);

			// If file name matches, add it as a result
			if (fileNameMatches) {
				results.push({
					file: file.basename,
					filePath: file.path,
					line: `File name match: ${file.path}`,
					lineNumber: 0,
					mtime: file.stat.mtime
				});
			}

			const content = await this.app.vault.read(file);
			const lines = content.split('\n');

			let inDataviewjsBlock = false;

			lines.forEach((line, index) => {
				const trimmedLine = line.trim();

				// Check if we're starting a dataviewjs block
				if (trimmedLine.startsWith('```dataviewjs')) {
					inDataviewjsBlock = true;
					return; // Skip this line
				}

				// Check if we're ending a code block
				if (inDataviewjsBlock && trimmedLine.startsWith('```')) {
					inDataviewjsBlock = false;
					return; // Skip this line
				}

				// If we're inside a dataviewjs block, skip this line
				if (inDataviewjsBlock) {
					return;
				}

				const lineLower = line.toLowerCase();
				// Check if all search terms are present in the line
				const matchesAll = searchTerms.every(term => lineLower.includes(term));

				if (matchesAll && line.trim().length > 0) {
					results.push({
						file: file.basename,
						filePath: file.path,
						line: line.trim(),
						lineNumber: index + 1,
						mtime: file.stat.mtime
					});
				}
			});
		}

		// Sort results by folder priority, then by updated date (desc)
		results.sort((a, b) => {
			const aPriority = this.getFolderPriority(a.filePath);
			const bPriority = this.getFolderPriority(b.filePath);

			// First sort by priority
			if (aPriority !== bPriority) {
				return aPriority - bPriority;
			}

			// Then sort by updated date (descending - newest first)
			return b.mtime - a.mtime;
		});

		// Format results
		if (results.length === 0) {
			return 'No results found.';
		}

		let response = `Found ${results.length} result(s):\n\n`;

		// Limit to top 50 results
		const limitedResults = results.slice(0, 50);

		limitedResults.forEach(result => {
			// Truncate long lines
			let displayLine = result.line;
			if (displayLine.length > 150) {
				displayLine = displayLine.substring(0, 150) + '...';
			}

			// Convert markdown links in the line content to HTML
			displayLine = this.convertWikiLinksToHTML(displayLine);

			// Extract folder name from file path
			const folderName = result.filePath.includes('/')
				? result.filePath.substring(0, result.filePath.lastIndexOf('/'))
				: '';

			// Include file path in the link data attribute so we can find it later
			// For file name matches (lineNumber === 0), add 📄 icon to the title
			if (result.lineNumber === 0) {
				response += `<a href="#" class="internal-link" data-file="${result.file}" data-filepath="${result.filePath}">📄 ${result.file}</a>\n${displayLine}\n\n`;
			} else {
				// Display folder name with line number if folder exists
				const locationText = folderName
					? `(${folderName}, line ${result.lineNumber})`
					: `(line ${result.lineNumber})`;
				response += `<a href="#" class="internal-link" data-file="${result.file}" data-filepath="${result.filePath}" data-line="${result.lineNumber}">${result.file}</a> ${locationText}\n${displayLine}\n\n`;
			}
		});

		if (results.length > 50) {
			response += `\n(Showing first 50 of ${results.length} results)`;
		}

		return response;
	}

	// Scan vault and collect all note contents
	async scanVaultContents(): Promise<string> {
		const notesFolder = 'Notes';
		const files = this.app.vault.getMarkdownFiles();
		let contents = '';
		let fileCount = 0;

		for (const file of files) {
			// Only include files in the Notes folder
			if (!file.path.startsWith(notesFolder + '/') && file.path !== notesFolder) {
				continue; // Skip this file
			}

			const content = await this.app.vault.read(file);
			contents += `\n\n--- File: ${file.path} ---\n${content}`;
			fileCount++;
		}

		return contents;
	}

	// Send query to Claude Code
	async queryClaudeCode(query: string, vaultContents: string): Promise<string> {
		// Safety check - Node.js modules required for AI features
		if (!spawn || !path) {
			return Promise.reject(new Error('AI features require Node.js modules which are only available on desktop platforms.'));
		}

		return new Promise((resolve, reject) => {
			try {
				// Create the prompt with formatting instructions
				const formatInstructions = `IMPORTANT: Format your response as follows:
1. Provide a very brief summary (1-2 sentences)
2. Reference files using Obsidian wiki-link format: [[FileName]] (without the .md extension)
3. Keep the response concise and focused

`;
				const contextPrompt = vaultContents
					? `${formatInstructions}I have the following notes from my Obsidian vault:\n\n${vaultContents}\n\n---\n\nUser Query: ${query}`
					: `${formatInstructions}${query}`;

				// Spawn Claude Code process with proper PATH
				const nodePath = path.dirname(this.settings.claudeCodePath);
				const env = {
					...process.env,
					PATH: `${nodePath}:${process.env.PATH || ''}`
				};

				const claudeProcess = spawn(this.settings.claudeCodePath, [], {
					shell: true,
					env: env
				});

				let stdout = '';
				let stderr = '';

				// Collect output
				claudeProcess.stdout.on('data', (data: Buffer) => {
					stdout += data.toString();
				});

				claudeProcess.stderr.on('data', (data: Buffer) => {
					stderr += data.toString();
				});

				// Handle process completion
				claudeProcess.on('close', (code: number) => {
					if (code !== 0 && !stdout) {
						console.error('Claude Code stderr:', stderr);
						reject(new Error(`AI Modal exited with code ${code}: ${stderr}`));
					} else {
						// Clean up the response - remove the prompt if it's echoed back
						let response = stdout || stderr || 'No response received';

						// If the response starts with our prompt, try to extract just the answer
						if (response.includes(contextPrompt)) {
							// Remove the prompt from the beginning
							response = response.replace(contextPrompt, '').trim();
						}

						// Remove ANSI color codes and other terminal formatting
						response = response.replace(/\x1b\[[0-9;]*m/g, '');

						// Convert [[FileName]] to clickable links
						response = this.convertWikiLinksToHTML(response);

						resolve(response);
					}
				});

				claudeProcess.on('error', (error: Error) => {
					reject(new Error(`Failed to start AI Modal: ${error.message}`));
				});

				// Write input to stdin and close it
				claudeProcess.stdin.write(contextPrompt);
				claudeProcess.stdin.end();

			} catch (error) {
				console.error('Error querying Claude Code:', error);
				reject(new Error(`Failed to query AI Modal: ${error.message}`));
			}
		});
	}
}

class NoteScannerView extends ItemView {
	plugin: ClaudeCodePlugin;
	inputEl: HTMLTextAreaElement;
	outputEl: HTMLDivElement;
	submitBtn: HTMLButtonElement;
	resetBtn: HTMLButtonElement;
	scanCheckbox: HTMLInputElement;
	collapseBtn: HTMLButtonElement;
	currentFileOnlyCheckbox: HTMLInputElement;
	aiSearchCheckbox: HTMLInputElement;
	inputSection: HTMLDivElement;
	isInputCollapsed: boolean = false;
	lastState: boolean | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeCodePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_NOTE_SCANNER;
	}

	getDisplayText(): string {
		return 'Note Scanner';
	}

	getIcon(): string {
		return 'search';
	}

	async onOpen() {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				const isCollapsed = this.app.workspace.rightSplit.collapsed;

				if (this.lastState === null) {
					this.lastState = isCollapsed;
					return;
				}

				if (this.lastState !== isCollapsed) {
					if (isCollapsed) {
						startCloseTimer(this.plugin.settings.autoCloseDelay, this.resetFields.bind(this));
					} else {
						cancelCloseTimer();
					}
					this.lastState = isCollapsed;
				}
			})
		);

		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('note-scanner-view');

		// Title with collapse button on mobile
		const titleContainer = container.createDiv('title-container');
		titleContainer.style.display = 'flex';
		titleContainer.style.justifyContent = 'space-between';
		titleContainer.style.alignItems = 'center';

		const headingEl = titleContainer.createEl('h2', { text: 'Note Scanner' });
    	headingEl.style.width = '100%';

		// Add collapse toggle button on mobile only
		if (Platform.isMobile) {
			this.collapseBtn = titleContainer.createEl('button', {
				text: '▼',
				cls: 'collapse-toggle-btn'
			});
			this.collapseBtn.style.fontSize = '20px';
			this.collapseBtn.style.cursor = 'pointer';
			this.collapseBtn.style.background = 'none';
			this.collapseBtn.style.border = 'none';
			this.collapseBtn.style.padding = 'unset';
    		this.collapseBtn.style.width = 'unset';
			this.collapseBtn.style.borderRadius = 'unset';
			this.collapseBtn.style.padding = 'unset';
			this.collapseBtn.style.margin = 'unset';
			this.collapseBtn.style.boxShadow = 'unset';

			this.collapseBtn.addEventListener('click', () => {
				this.toggleInputSection();
			});
		}

		// Create input section wrapper
		this.inputSection = container.createDiv('input-section-wrapper');

		// Scan vault checkbox (only show if AI mode is enabled)
		if (this.plugin.settings.useAI) {
			const checkboxContainer = this.inputSection.createDiv('checkbox-container');
			this.scanCheckbox = checkboxContainer.createEl('input', {
				type: 'checkbox',
				attr: { checked: 'checked' }
			});
			checkboxContainer.createEl('label', {
				text: 'Include vault contents in query'
			});
		}

		// Input area
		this.inputSection.createEl('h3', { text: 'Your Query:' });
		const inputContainer = this.inputSection.createDiv('input-section');
		this.inputEl = inputContainer.createEl('textarea', {
			attr: {
				placeholder: 'Enter your question or prompt...',
				rows: '6'
			}
		});

		// Current file only checkbox (only show if fuzzy search mode)
		if (!this.plugin.settings.useAI) {
			const checkboxContainer = inputContainer.createDiv('checkbox-container');
			this.currentFileOnlyCheckbox = checkboxContainer.createEl('input', {
				type: 'checkbox',
				attr: { id: 'current-file-only-checkbox' }
			});
			const label = checkboxContainer.createEl('label', {
				text: 'Current file only',
				attr: { for: 'current-file-only-checkbox' }
			});
			label.style.cursor = 'pointer';
			label.style.marginTop = '2px';

			// Add event listener to change container background when checked
			this.currentFileOnlyCheckbox.addEventListener('change', (e) => {
				const target = e.target as HTMLInputElement;
				if (target.checked) {
					checkboxContainer.addClass('checkbox-checked');
				} else {
					checkboxContainer.removeClass('checkbox-checked');
				}
				// Update button text based on checkbox state
				this.submitBtn.setText(this.getSearchButtonText());
			});
		}

		// AI Search checkbox (only show on desktop)
		if (Platform.isDesktop) {
			const aiCheckboxContainer = inputContainer.createDiv('checkbox-container');
			this.aiSearchCheckbox = aiCheckboxContainer.createEl('input', {
				type: 'checkbox',
				attr: { id: 'ai-search-checkbox' }
			});
			const aiLabel = aiCheckboxContainer.createEl('label', {
				text: 'AI Search',
				attr: { for: 'ai-search-checkbox' }
			});
			aiLabel.style.cursor = 'pointer';
			aiLabel.style.marginTop = '2px';

			// Add event listener to change container background when checked
			this.aiSearchCheckbox.addEventListener('change', (e) => {
				const target = e.target as HTMLInputElement;
				if (target.checked) {
					aiCheckboxContainer.addClass('checkbox-checked');
				} else {
					aiCheckboxContainer.removeClass('checkbox-checked');
				}
				// Update button text based on checkbox state
				this.submitBtn.setText(this.getSearchButtonText());
			});
		}

		// Submit button
		const buttonContainer = this.inputSection.createDiv('button-container');
		this.submitBtn = buttonContainer.createEl('button', {
			text: this.getSearchButtonText(),
			cls: 'mod-cta'
		});

		this.submitBtn.addEventListener('click', async () => {
			await this.handleSubmit();
		});

		// Reset button (initially hidden)
		this.resetBtn = buttonContainer.createEl('button', {
			text: 'Reset',
			cls: 'mod-warning'
		});
		this.resetBtn.style.display = 'none';
		this.resetBtn.style.marginTop = '8px';

		this.resetBtn.addEventListener('click', () => {
			this.resetFields();
		});

		// Output area
		container.createEl('h3', { text: 'Results:' });
		this.outputEl = container.createDiv('output-area');
		this.outputEl.setText('');

		// Handle Enter key to submit
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.handleSubmit();
			}
		});

		// Handle Escape key to close right sidebar
		this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				// Check if our view is in the right sidebar
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTE_SCANNER);
				if (leaves.length > 0 && leaves.includes(this.leaf)) {
					this.app.workspace.rightSplit.collapse();
				}
			}
		});

		// Focus the input field
		this.inputEl.focus();
	}

	async handleSubmit() {
		const query = this.inputEl.value.trim();

		if (!query) {
			new Notice('Please enter a query');
			return;
		}

		this.submitBtn.disabled = true;
		this.submitBtn.setText('Processing...');

		try {
			let response: string;

			// Check if AI search should be used (either plugin setting or desktop checkbox)
			const useAISearch = this.plugin.settings.useAI || (Platform.isDesktop && this.aiSearchCheckbox && this.aiSearchCheckbox.checked);

			if (useAISearch) {
				// Use AI mode
				this.outputEl.setText('Scanning vault and querying...');
				let vaultContents = '';

				if (this.scanCheckbox && this.scanCheckbox.checked) {
					new Notice('Scanning vault contents...');
					vaultContents = await this.plugin.scanVaultContents();
				}

				new Notice('Sending query to...');
				response = await this.plugin.queryClaudeCode(query, vaultContents);
			} else {
				// Use fuzzy search mode
				const currentFileOnly = this.currentFileOnlyCheckbox && this.currentFileOnlyCheckbox.checked;
				let currentFilePath: string | undefined;

				if (currentFileOnly) {
					const activeFile = this.app.workspace.getActiveFile();
					if (!activeFile) {
						new Notice('No active file to search');
						this.submitBtn.disabled = false;
						this.submitBtn.setText('Search');
						return;
					}
					currentFilePath = activeFile.path;
					this.outputEl.setText('Searching current file...');
					new Notice('Searching current file...');
				} else {
					this.outputEl.setText('Searching vault...');
					// new Notice('Searching vault...');
				}

				response = await this.plugin.fuzzySearch(query, currentFileOnly, currentFilePath);
			}

			if (response !== 'No results found.') {
				this.toggleInputSection();
			}

			// Use innerHTML to render clickable links
			this.outputEl.innerHTML = response.replace(/\n/g, '<br>');

			// Add click handlers for internal links
			this.outputEl.querySelectorAll('a.internal-link').forEach(link => {
				link.addEventListener('click', async (e) => {
					e.preventDefault();
					const element = e.target as HTMLElement;
					const fullLink = element.getAttribute('data-file');
					const filePath = element.getAttribute('data-filepath');
					const lineNumber = element.getAttribute('data-line');

					if (fullLink) {
						let file;

						// If we have a direct file path (from fuzzy search), use it
						if (filePath) {
							file = this.app.vault.getAbstractFileByPath(filePath);
						} else {
							// Otherwise, search for the file (from AI results or wiki links)
							const [fileName] = fullLink.split('#');
							const files = this.app.vault.getMarkdownFiles();

							// First try exact path match
							file = this.app.vault.getAbstractFileByPath(fileName.trim() + '.md');

							// If not found, search in Notes folder
							if (!file) {
								file = files.find(f => {
									const baseName = f.basename;
									const isInNotes = f.path.startsWith('Notes/');
									return isInNotes && baseName === fileName.trim();
								});
							}

							// If still not found, search entire vault by basename
							if (!file) {
								file = files.find(f => f.basename === fileName.trim());
							}
						}

						if (file instanceof TFile) {
							// Open in the active leaf (replaces current view) in editing mode
							const leaf = this.app.workspace.getLeaf(false);
							await leaf.openFile(file, { state: { mode: 'source' } });

							// If we have a line number, scroll to it
							if (lineNumber) {
								const line = parseInt(lineNumber) - 1; // Convert to 0-indexed
								const view = leaf.view;

								// Wait a moment for the view to be ready
								setTimeout(() => {
									if (view && 'editor' in view) {
										const editor = (view as any).editor;
										if (editor) {
											const cursorPos = { line, ch: 0 };
											editor.setCursor(cursorPos);
											editor.scrollIntoView(
												{
													from: cursorPos,
													to: cursorPos,
												},
												'center'
											);
										}
									}
								}, 100);
							}

							new Notice(`Opened: ${fullLink}${lineNumber ? ` at line ${lineNumber}` : ''}`);
						} else {
							new Notice(`File not found: ${fullLink}`);
						}
					}
				});
			});

			// Add click handlers for external links
			this.outputEl.querySelectorAll('a.external-link').forEach(link => {
				link.addEventListener('click', (e) => {
					e.preventDefault();
					const element = e.target as HTMLElement;
					const url = element.closest('a')?.getAttribute('href');
					if (url) {
						window.open(url, '_blank');
						new Notice('Opened external link');
					}
				});
			});

			// Show reset button after results are displayed
			this.resetBtn.style.display = 'flex';

			// new Notice('Results ready!');
		} catch (error) {
			this.outputEl.setText(`Error: ${error.message}`);
			new Notice('Error querying Note Scanner');
			console.error(error);
		} finally {
			this.submitBtn.disabled = false;
			this.submitBtn.setText(this.getSearchButtonText());
		}
	}

	getSearchButtonText(): string {
		// If on desktop and AI search is checked, show AI Search
		if (Platform.isDesktop && this.aiSearchCheckbox && this.aiSearchCheckbox.checked) {
			return 'AI Search';
		}
		// If in AI mode or no current file checkbox exists, just say "Search"
		if (this.plugin.settings.useAI || !this.currentFileOnlyCheckbox) {
			return 'Search';
		}
		// In fuzzy search mode, check the checkbox state
		return this.currentFileOnlyCheckbox.checked ? 'Search Current File' : 'Search Vault';
	}

	resetFields() {
		// Clear input and output fields
		if (this.inputEl) {
			this.inputEl.value = '';
		}
		if (this.outputEl) {
			this.outputEl.innerHTML = '';
		}
		// Reset checkboxes if they exist
		if (this.scanCheckbox) {
			this.scanCheckbox.checked = true;
		}
		if (this.currentFileOnlyCheckbox) {
			this.currentFileOnlyCheckbox.checked = false;
			// Remove the checked class
			const checkboxContainer = this.currentFileOnlyCheckbox.parentElement;
			if (checkboxContainer) {
				checkboxContainer.removeClass('checkbox-checked');
			}
		}
		if (this.aiSearchCheckbox) {
			this.aiSearchCheckbox.checked = false;
			// Remove the checked class
			const aiCheckboxContainer = this.aiSearchCheckbox.parentElement;
			if (aiCheckboxContainer) {
				aiCheckboxContainer.removeClass('checkbox-checked');
			}
		}
		// Update button text after resetting checkboxes
		this.submitBtn.setText(this.getSearchButtonText());
		// Hide reset button after clearing
		this.resetBtn.style.display = 'none';
	}

	toggleInputSection() {
		if (Platform.isMobile && this.collapseBtn) {
			this.isInputCollapsed = !this.isInputCollapsed;

			if (this.isInputCollapsed) {
				// Collapse the input section
				this.inputSection.style.display = 'none';
				this.collapseBtn.setText('▶');
			} else {
				// Expand the input section
				this.inputSection.style.display = 'block';
				this.collapseBtn.setText('▼');
			}
		} 
	}

	async onClose() {
		// Cleanup if needed
	}
}

class ClaudeCodeSettingTab extends PluginSettingTab {
	plugin: ClaudeCodePlugin;

	constructor(app: App, plugin: ClaudeCodePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Note Scanner Integration Settings' });

		// AI toggle - disabled on mobile
		new Setting(containerEl)
			.setName('Use AI')
			.setDesc(Platform.isMobile
				? 'AI-powered search is only available on desktop. Mobile uses fuzzy search.'
				: 'Enable AI-powered search using your AI Modeal. When disabled, uses simple fuzzy search.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useAI)
				.setDisabled(Platform.isMobile)
				.onChange(async (value) => {
					this.plugin.settings.useAI = value;
					await this.plugin.saveSettings();
				}));

		// Hide AI-specific settings on mobile
		if (Platform.isDesktop) {
			new Setting(containerEl)
				.setName('Vault Path')
				.setDesc('Path to your Obsidian vault (default: auto-detected)')
				.addText(text => text
					.setPlaceholder('/path/to/vault')
					.setValue(this.plugin.settings.vaultPath)
					.onChange(async (value) => {
						this.plugin.settings.vaultPath = value;
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('AI Modal Command')
				.setDesc('Command to run AI Modal CLI (e.g., "claude" or full path). Only used when "Use AI" is enabled.')
				.addText(text => text
					.setPlaceholder('claude')
					.setValue(this.plugin.settings.claudeCodePath)
					.onChange(async (value) => {
						this.plugin.settings.claudeCodePath = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Excluded Folders')
			.setDesc('Folders to exclude from fuzzy search (comma-separated). E.g., "archive, .obsidian, Templates"')
			.addTextArea(text => text
				.setPlaceholder('archive, .obsidian, Bookmarks')
				.setValue(this.plugin.settings.excludedFolders.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.excludedFolders = value
						.split(',')
						.map(folder => folder.trim())
						.filter(folder => folder.length > 0);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Prioritized Folders')
			.setDesc('Folders to prioritize in fuzzy search results, in order of priority (comma-separated). Use "/", "root", or "Root" for root folder. E.g., "/, Notes, Tech" or "root, Notes, Tech"')
			.addTextArea(text => text
				.setPlaceholder('/, Notes, Tech')
				.setValue(this.plugin.settings.prioritizedFolders.join(', '))
				.onChange(async (value) => {
					this.plugin.settings.prioritizedFolders = value
						.split(',')
						.map(folder => folder.trim());
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-close Delay')
			.setDesc('Time in seconds before auto-clearing the search fields when sidebar is collapsed (default: 10 seconds)')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(String(this.plugin.settings.autoCloseDelay / 1000))
				.onChange(async (value) => {
					const seconds = parseInt(value);
					if (!isNaN(seconds) && seconds > 0) {
						this.plugin.settings.autoCloseDelay = seconds * 1000;
						await this.plugin.saveSettings();
					}
				}));
	}
}
