import { App, Modal, Plugin, PluginSettingTab, Setting, TextComponent, WorkspaceLeaf, View } from 'obsidian';

interface RecentFilesSettings {
	historyLength: number;
	files: string[];
}

const DEFAULT_SETTINGS: RecentFilesSettings = {
	historyLength: 15,
	files: [],
}

export default class RecentFilesPlugin extends Plugin {
	settings: RecentFilesSettings

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'open-recent-files-modal-simple',
			name: 'Open recent tabs modal',
			callback: () => {
				new RecentFilesModal(this.app, this.settings, this.saveFiles.bind(this)).open();
			}
		});

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
}

class RecentFilesModal extends Modal {
	historyLength = DEFAULT_SETTINGS.historyLength;
	selectedIndex = 0;
	allRecentFiles: string[] = [];
	allRecentTabs: WorkspaceLeaf[] = [];
	saveFiles: (files: string[]) => Promise<void>;
	searchText = '';

	constructor(app: App, settings: RecentFilesSettings, saveData: (files: string[]) => Promise<void>) {
		super(app);
		this.historyLength = settings.historyLength
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
			this.allRecentFiles = files.concat(difference).slice(0, this.historyLength);
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

		const dailyNoteIndex = openTabs.findIndex((tab) => (tab.view as any).title === 'Daily ToDo List' || (tab.view as any).file?.basename === 'Daily ToDo List');
		if (dailyNoteIndex < 0) {
			const tmpView = {
				title: 'Daily ToDo List',
				custom: 'daily-notes'
			} as unknown as View;
			// @ts-ignore
			openTabs.unshift({ view: tmpView });
		}
		const dashboardIndex = openTabs.findIndex((tab) => (tab.view as any).title === 'Dashboard' || (tab.view as any).file?.basename === 'Dashboard');
		if (dashboardIndex < 0) {
			const tmpView = {
				title: 'Dashboard',
				custom: 'dashboard',
			} as unknown as View;
			// @ts-ignore
			openTabs.unshift({ view: tmpView });
		}
		const updatedTabs = openTabs.filter(tab => this._getTabTitle(tab) !== this._getTabTitle(selectedLeaf));
		const sortedTabs = this._sortOpenTabs(updatedTabs);
		const tabMap = new Map<string, WorkspaceLeaf>();
		for (const item of sortedTabs) {
			const key = this._getTabTitle(item);
			tabMap.set(key, item);
		}
		const tabsToReturn = [...tabMap.values()];
		return tabsToReturn;
	}

	_sortOpenTabs = (tabs: WorkspaceLeaf[]) => {
		const first = tabs[0];
		const rest = tabs.slice(1);

		// const priority = { 'Daily ToDo List': 1, 'Dashboard': 2};
		const priority: Record<string, number> = {
			'Daily ToDo List': 1,
			'Dashboard': 2,
		};

		const sorted = rest.sort((a, b) => {
			const aPriority = priority[this._getTabTitle(a)] ?? Infinity;
			const bPriority = priority[this._getTabTitle(b)] ?? Infinity;
			return aPriority - bPriority;
		});

		return [first, ...sorted];
	};

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
		return (fileName as string).replace(/\.[^/.]+$/, '');
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
				filterTabs = tabs.filter(f => this._getTabTitle(f).toLocaleUpperCase().indexOf(text.toLocaleUpperCase()) > -1);
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
			const targetFile = this.app.vault.getFiles().find((f) => {
				return f.basename === currentFile;
			});

			if (targetFile) {
				let leaf = this.app.workspace.getMostRecentLeaf();
				await app.workspace.iterateAllLeaves((openLeaf: WorkspaceLeaf) => {
					const view = this._getView(openLeaf);
					if (
					view.modes &&
					view.file &&
					view.file.path === targetFile.path
					) {
					leaf = openLeaf;
					}
				});
				if (!leaf) {
					leaf = this.app.workspace.getLeaf('tab');
				}
				//@ts-ignore
				leaf.openFile(targetFile, { active: true });
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
			.setName('History Size')
			.setDesc('Number of tabs to show in the list')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.historyLength.toString())
				.setValue(this.plugin.settings.historyLength.toString())
				.onChange(async (value) => {
					this.plugin.settings.historyLength = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
