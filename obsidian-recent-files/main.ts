import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TextComponent, WorkspaceLeaf, View, TFile } from 'obsidian';

interface RecentFilesSettings {
	files: string[];
	vaultName: string;
	pinnedFiles: string[];
	showDailyNote: boolean;
	showPinnedNoteInRibbon: boolean;
}

const DEFAULT_SETTINGS: RecentFilesSettings = {
	files: [],
	vaultName: '',
	pinnedFiles: [],
	showDailyNote: false,
	showPinnedNoteInRibbon: false,
}

const getTargetFile = (app: App, fileName: string): TFile | null => {
	// Try to find file by full path first, then by basename
	let targetFile = fileName.endsWith('.md') ? 
		app.vault.getAbstractFileByPath(fileName) 
		: app.vault.getAbstractFileByPath(fileName + '.md');

	if (!targetFile) {
		// Fall back to searching by basename
		const foundFile = app.vault.getFiles().find((f) => {
			return f.basename === fileName;
		});
		targetFile = foundFile || null;
	}
	return targetFile instanceof TFile ? targetFile : null;
};

export default class RecentFilesPlugin extends Plugin {
	settings: RecentFilesSettings
	ribbonIcons: HTMLElement[] = [];

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'open-recent-files-modal-simple',
			name: 'Open recent tabs modal',
			callback: () => {
				new RecentFilesModal(this.app, this.settings, this.saveFiles.bind(this)).open();
			}
		});
		this.addRibbonIcon(
			'file-text',
			`Open recent tabs modal`,
			async () => {
				new RecentFilesModal(this.app, this.settings, this.saveFiles.bind(this)).open();
			}
		);
		if (this.settings.showPinnedNoteInRibbon) {
			this.addPinnedNotesToRibbon();
		}
		
		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));
	}

	onunload() {

	}
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async saveFiles(files: string[]): Promise<void> {
		await this.saveData({
			...this.settings,
			files: files
		});
	}

	async addPinnedNotesToRibbon() {
  		if (this.ribbonIcons.length > 0) return;

  		this.settings.pinnedFiles.forEach((fileName) => {
    		const displayName =
      			fileName.replace(/\.[^/.]+$/, '').split('/').pop() || fileName;

		    const icon = this.addRibbonIcon(
  				'file-text',
     			`Open Pinned Note: ${displayName}`,
				async () => {
        			const file = getTargetFile(this.app, fileName);
        			if (file instanceof TFile) {
          				await this.app.workspace.getLeaf(true).openFile(file);
        			} else {
          				new Notice(`${fileName} not found in vault.`);
        			}
      			}
    		);

    		this.ribbonIcons.push(icon);
  		});
	}

  	async removePinnedNotesFromRibbon() {
  		this.ribbonIcons.forEach(icon => icon.remove());
  		this.ribbonIcons = [];
	}
}

class RecentFilesModal extends Modal {
	selectedIndex = 0;
	allRecentFiles: string[] = [];
	allRecentTabs: WorkspaceLeaf[] = [];
	saveFiles: (files: string[]) => Promise<void>;
	searchText = '';
	settings: RecentFilesSettings;

	constructor(app: App, settings: RecentFilesSettings, saveData: (files: string[]) => Promise<void>) {
		super(app);
		this.settings = settings;
		this.saveFiles = saveData;

		const files = this.app.workspace.getLastOpenFiles().map((filePath) => {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file) {
				return file.path;
			}
			return null;
		}).filter(Boolean) as string[];
		if (settings.files && settings.files.length > 0) {
			const realFiles = settings.files.map((filePath) => {
			const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file) {
					return file.path;
				}
				return null;
			}).filter(Boolean) as string[];
			const difference = realFiles.filter((x: string) => !files.includes(x));
			this.allRecentFiles = files.concat(difference);
		} else {
			this.allRecentFiles = files;
		}
	}

	onOpen() {
		const filesToShow = this.allRecentFiles;
		const tabs = this._getOpenTabs();
		this._draw(filesToShow, tabs);
	}

	onClose() {
		const {contentEl} = this;
		this.storeFiles();
		contentEl.empty();
	}

	_getOpenTabs(): WorkspaceLeaf[] {
		const selectedLeaf = app.workspace.getMostRecentLeaf() as WorkspaceLeaf;
		const lastFiles = this.app.workspace.getLastOpenFiles();
		const recentIndexMap = new Map<string, number>();
			lastFiles.forEach((path: string, index: number) => {
			recentIndexMap.set(path, index);
		});
		const openTabs: WorkspaceLeaf[] = [];
		app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
			const view = this._getView(leaf);
			const viewType = view.getViewType();
			if ((leaf as any).id !== (selectedLeaf as any).id && (viewType === 'markdown' || viewType === 'webviewer')) {
				openTabs.push(leaf);
			}
		});
		lastFiles.forEach(tab => {
			const title = tab.replace(/\.[^/.]+$/, '').split('/').pop() || 'unknown';
			const custom = title.replace(/\s+/g, '-');
			// @ts-ignore
			const hasEntry = openTabs.some(item => item.view?.title === title);
			if (!hasEntry) {
				const tmpView = {
					title,
					custom
				} as unknown as View;
				// @ts-ignore
				openTabs.push({ view: tmpView });
			}
		});
		openTabs.sort((a: WorkspaceLeaf, b: WorkspaceLeaf) => {
			const aView = this._getView(a);
			const bView = this._getView(b);
			const aName = aView.state?.file ?? aView.file?.path;
			const bName = bView.state?.file ?? bView.file?.path;
			const aIndex = recentIndexMap.get(aName) ?? Infinity;
			const bIndex = recentIndexMap.get(bName) ?? Infinity;
			return aIndex - bIndex;
		});

		// Build pinned files list from settings
		const pinnedFiles: Array<{ title: string; custom: string }> = [];

		// Add daily note if enabled
		if (this.settings.showDailyNote) {
			pinnedFiles.push({ title: 'Todays Daily Note', custom: 'daily-notes' });
		}

		// Add user-configured pinned files
		for (const fileName of this.settings.pinnedFiles) {
			if (fileName.trim()) {
				// Extract basename for display (remove extension and path)
				const displayName = fileName.trim()
					.replace(/\.[^/.]+$/, '') // Remove extension
					.split('/').pop() || fileName.trim(); // Get last part of path

				pinnedFiles.push({
					title: fileName.trim(), // Store full path/name for lookup
					custom: displayName.replace(/\s+/g, '-').toLowerCase()
				});
			}
		}

		// Get today's date in daily note format (YYYY-MM-DD)
		const today = new Date();
		const dailyNoteFilename = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

		// Create a set of pinned basenames for efficient matching
		// Extract basename from each pinned file (handles both "TaskList" and "Notes/TaskList.md")
		const pinnedBasenames = new Set(pinnedFiles.map(p => {
			const title = p.title.replace(/\.[^/.]+$/, '').split('/').pop() || p.title;
			return title.toLowerCase();
		}));

		// Remove pinned files and today's daily note from openTabs (to avoid duplicates)
		const filteredTabs = openTabs.filter(tab => {
			const title = this._getTabTitle(tab);
			const basename = title.replace(/\.[^/.]+$/, '').split('/').pop() || title;

			// Exclude if matches any pinned file basename
			if (pinnedBasenames.has(basename.toLowerCase())) return false;
			// Exclude today's daily note file if daily note option is enabled
			if (this.settings.showDailyNote && title.includes(dailyNoteFilename)) return false;
			return true;
		});

		// Add pinned files at the beginning
		const pinnedTabs: WorkspaceLeaf[] = [];
		for (const pinned of pinnedFiles) {
			const tmpView = {
				title: pinned.title,
				custom: pinned.custom
			} as unknown as View;
			// @ts-ignore
			pinnedTabs.push({ view: tmpView, isPinned: true });
		}

		// Get the second most recent tab (last viewed before current) for easy switching back
		const previousTab = filteredTabs.length > 0 ? [filteredTabs[0]] : [];

		// Get remaining tabs (already limited by Obsidian API to max 10)
		const restTabs = filteredTabs.slice(1);

		// Combine: previous tab first, then pinned files, then the rest
		const combinedTabs = [...previousTab, ...pinnedTabs, ...restTabs];

		return combinedTabs;
	}


	_draw(filesToShow: string[], tabs: WorkspaceLeaf[]): void {
		const { contentEl } = this;
		const rootEl = createDiv({ cls: 'nav-folder mod-root, recent-files-root' });
		rootEl.setText('Recent Tabs');
		const childrenEl = rootEl.createDiv({ cls: 'nav-folder-children' });
		const searchBox = this._createSearchBox(childrenEl, filesToShow, tabs);

		const endOfFilesIndex = tabs ? tabs.length - 1 : filesToShow.length - 1;
		const items = tabs || filesToShow;

		items.forEach((currentFile: any, index: number) => {
			const navFile = childrenEl.createDiv({ cls: 'nav-file recent-files-file' });
			const navFileTitle = navFile.createDiv({ cls: 'nav-file-title recent-files-title' });
			const navFileTitleContent = navFileTitle.createDiv({ cls: 'nav-file-title-content recent-files-title-content' });

			// remove extension for display text
			const fileDisplayName = this._getDisplayName(currentFile);
			navFileTitleContent.setText(fileDisplayName);

			navFileTitleContent.addEventListener('click', (event: MouseEvent) => {
				this._openFile(currentFile);
			});
			// Add css to first item in list on render
			if (index === 0) {
				navFile.addClass('recent-files-selected');
			}
		});

		childrenEl.addEventListener('keydown', (event: any) => {
			const children = childrenEl.getElementsByClassName('recent-files-file');
			if (children) {
				const previousIndex = this.selectedIndex;
				if (event.key === "ArrowDown" && this.selectedIndex < endOfFilesIndex) {
					//down
					this.selectedIndex++;
				} else if (event.key === "ArrowUp" && this.selectedIndex != 0) {
					//up
					this.selectedIndex--;
				}
				if (previousIndex != this.selectedIndex) {
				children[previousIndex].removeClass('recent-files-selected');
				children[this.selectedIndex].addClass('recent-files-selected');
				}
			}
			if (event.key === "Enter") {
				//enter
				if (this.selectedIndex >= 0 && this.selectedIndex <= endOfFilesIndex) {
					this._openFile(items[this.selectedIndex])
				}
			}
		});
		contentEl.empty();
		contentEl.appendChild(rootEl);
		if (searchBox.inputEl) {
			searchBox.inputEl.focus();
		}
	}

	_getDisplayName(currentFile: string | WorkspaceLeaf): string {
		const fileName = this._getTabTitle(currentFile);
		// Remove extension and get just the basename for display
		return (fileName as string)
			.replace(/\.[^/.]+$/, '') // Remove extension
			.split('/').pop() || fileName as string; // Get last part of path
	}

	_createSearchBox(childrenEl: HTMLElement, filesToShow: string[], tabs: WorkspaceLeaf[]): TextComponent {
		const input = new TextComponent(childrenEl)
			.setPlaceholder("Search")
			.setValue(this.searchText)
			.onChange((text) => this._handleSearch(text, filesToShow, tabs));
		if (input.inputEl) {
			input.inputEl.addClass('recent-files-search-box');
		}
		return input;
	}

	_handleSearch(text: string, filesToShow: string[], tabs: WorkspaceLeaf[]): void {
		this.searchText = text;
		let filteredFiles = this.allRecentFiles;
		let filterTabs = this.allRecentTabs;
		if (text.length >= 1) {
			this.selectedIndex = 0;
			if (tabs) {
				// Filter tabs while maintaining order: previous tab first, then pinned, then rest
				const searchUpper = text.toLocaleUpperCase();
				const previousTab = tabs.length > 0 && !(tabs[0] as any).isPinned
					? tabs.filter((f: any, index: number) => index === 0 && this._getTabTitle(f).toLocaleUpperCase().indexOf(searchUpper) > -1)
					: [];
				const pinnedTabs = tabs.filter((f: any) => f.isPinned && this._getTabTitle(f).toLocaleUpperCase().indexOf(searchUpper) > -1);
				const regularTabs = tabs.filter((f: any, index: number) => !f.isPinned && index !== 0 && this._getTabTitle(f).toLocaleUpperCase().indexOf(searchUpper) > -1);
				filterTabs = [...previousTab, ...pinnedTabs, ...regularTabs];
			} else{
				filteredFiles = filesToShow.filter(f => f.toLocaleUpperCase().indexOf(text.toLocaleUpperCase()) > -1);
			}
		}
		this._draw(filteredFiles, filterTabs);
	}

	_getView(tab: WorkspaceLeaf | string): any {
		const view = (tab as any).view;
		if (view) {
			return view;
		}
		return undefined;
	}

	_getTabTitle(tab: WorkspaceLeaf | string | any): string {
		const view = this._getView(tab as WorkspaceLeaf);
		if (view) {
			return view.title || view.file?.basename || 'unknown';
		}
		return tab as string;
	}

	async _openFile(item: string|WorkspaceLeaf): Promise<void> {
		if (item instanceof WorkspaceLeaf && item.view?.leaf) {
			app.workspace.setActiveLeaf(item as WorkspaceLeaf);
			this.close();
		} else {
			const currentFile = this._getView(item)?.title || item;

			// Handle special case for Todays Daily Note
			if (currentFile === 'Todays Daily Note') {
				if (!this.settings.vaultName || this.settings.vaultName.trim() === '') {
					new Notice('Vault name is not set. Please configure it in plugin settings.');
					this.close();
					return;
				}
				window.open(`obsidian://adv-uri?vault=${encodeURIComponent(this.settings.vaultName)}&daily=true`);
				this.close();
				return;
			}

			const targetFile = getTargetFile(this.app, currentFile);

			if (targetFile) {
				let leaf = this.app.workspace.getMostRecentLeaf();
				const targetPath = targetFile.path;

				// Check if file is already open in a leaf
				app.workspace.iterateAllLeaves((openLeaf: WorkspaceLeaf) => {
					const view = this._getView(openLeaf);
					if (
					view.modes &&
					view.file &&
					view.file.path === targetPath
					) {
					leaf = openLeaf;
					}
				});

				if (!leaf) {
					leaf = this.app.workspace.getLeaf('tab');
				}

				//@ts-ignore
				await leaf.openFile(targetFile, { active: true });
				this.close();
			}
		}
	}

	async storeFiles(): Promise<void> {
		await this.saveFiles(this.allRecentFiles);
	}
}

class SettingTab extends PluginSettingTab {
	plugin: RecentFilesPlugin;

	constructor(app: App, plugin: RecentFilesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Settings for recent tabs list'});

		new Setting(containerEl)
			.setName('Vault Name')
			.setDesc('Name of your Obsidian vault (required for daily note feature)')
			.addText(text => text
				.setPlaceholder('Enter vault name')
				.setValue(this.plugin.settings.vaultName)
				.onChange(async (value) => {
					this.plugin.settings.vaultName = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show Daily Note')
			.setDesc('Show "Todays Daily Note" at the top of the recent files list')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showDailyNote)
				.onChange(async (value) => {
					this.plugin.settings.showDailyNote = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Pinned Files')
			.setDesc('File names to always show at the top (one per line). You can use either basename (e.g., "TaskList") or full path (e.g., "Notes/TaskList.md").')
			.addTextArea(text => text
				.setPlaceholder('Dashboard\nNotes/TaskList\nNotes/NoteList.md')
				.setValue(this.plugin.settings.pinnedFiles.join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.pinnedFiles = value.split('\n').filter(line => line.trim());
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Show Pinned Note in Ribbon')
			.setDesc('Show Pinned Note in the ribbon for quick access')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showPinnedNoteInRibbon)
				.onChange(async (value) => {
					this.plugin.settings.showPinnedNoteInRibbon = value;
					await this.plugin.saveSettings();
					if (value) {
						this.plugin.addPinnedNotesToRibbon();
					} else {
						this.plugin.removePinnedNotesFromRibbon();
					}
				})
			);
	}
}
