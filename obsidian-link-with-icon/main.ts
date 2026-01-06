import { App, Editor, MarkdownView, Plugin, PluginSettingTab, Setting } from 'obsidian';


interface LinkWithIconSettings {
	iconDir: string;
}

const DEFAULT_SETTINGS: LinkWithIconSettings = {
	iconDir: 'attachments/icons'
}

export default class LinkWithIconPlugin extends Plugin {
	settings: LinkWithIconSettings
	lineSyntax?: string;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'insert-link-with-icon',
			name: 'Insert link with icon',
			editorCallback: async(editor: Editor, view: MarkdownView) => {
				const selectedText = editor.getSelection();
				const linkSyntax = `[${selectedText}]()`;
				this.lineSyntax = this.getLinkSyntax(editor, selectedText);
				const cursor = editor.getCursor();
				editor.replaceSelection(linkSyntax);
				const newCursor = {
					line: cursor.line,
					ch: cursor.ch + selectedText.length + 3,
				};
				editor.setCursor(newCursor);
			}
		});
		this.registerEvent(
			this.app.workspace.on('editor-paste', (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => {
				const clipboardData = evt.clipboardData;
				if (!clipboardData) return;

				const pastedText = clipboardData.getData('text');

				if (this.isValidURL(pastedText)) {
					evt.preventDefault(); // Stop default paste
					this.handlePaste(pastedText, editor);
					
				}
			})
		);

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));
	}

	onunload() { }
	
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	handlePaste = (pastedText: string, editor: Editor) => {
		if (!this.lineSyntax) {
			const selectedText = editor.getSelection();
			let textToInsert = pastedText; 
			if (selectedText.length > 0) {
				// This flow support a direct paste on a selection
				textToInsert = this.buildLink(pastedText, `[${selectedText}]()`);
			}
			editor.replaceSelection(textToInsert);
		} else {
			const link = this.buildLink(pastedText, this.lineSyntax);
			const from = editor.getCursor('from');
			const newCursorPos = { from: { line: from.line, ch: 0 }, to: { line: from.line, ch: this.lineSyntax.length } };
			editor.replaceRange(link, newCursorPos.from, newCursorPos.to);
			editor.setCursor({ line: newCursorPos.from.line, ch: link.length });
			this.lineSyntax = undefined;
		}
	}
	handlePaste2 = (pastedText: string, editor: Editor) => {
		const selectionToModify = this.lineSyntax;
		const link = this.buildLink(pastedText, selectionToModify);
		const from = editor.getCursor('from');
		const newCursorPos = { from: { line: from.line, ch: from.ch }, to: { line: from.line, ch: from.ch } };
		if (selectionToModify) {
			newCursorPos.from.ch = 0;
			newCursorPos.to.ch = selectionToModify.length;
		} else {
			// This flow support a direct paste on a selection
			const selectedText = editor.getSelection();
			if (selectedText.length > 0) {
				const g = this.buildLink(pastedText, `[${selectedText}]()`);
				editor.replaceSelection(g);
				return;
			}
		}
		editor.replaceRange(link, newCursorPos.from, newCursorPos.to);
		const newEndOfLine = link === pastedText ? from.ch + pastedText.length : link.length;
		editor.setCursor({ line: from.line, ch: newEndOfLine });
		this.lineSyntax = undefined;
	}

	buildLink = (pastedText: string, input?: string,) => {
		if (input) {
			const icon = this.getIconFile(pastedText);
			const withUrl = this.insertIntoBrackets(input, pastedText);
			const link = this.insertImageIntoMarkdownLinks(withUrl, icon);
			return link
		}
		return pastedText
	}

	getLinkSyntax = (editor: Editor, input?: string) => {
		const selectedText = input ?? editor.getSelection();
		if (selectedText.length > 0) {
			const line = editor.getLine(editor.getCursor().line);
			const linkSyntax = `[${selectedText}]()`;
			return line.replace(selectedText, linkSyntax);
		}
		return undefined;
	}

	getIconFile = (input: string) => {
		const iconDir = this.settings.iconDir;
		const iconFiles = app.vault
			.getFiles()
			.filter((f) => f.path.substring(0, f.path.lastIndexOf('/')) === iconDir)
			.map((f) => f.basename);

		const icon = input
			.replaceAll(':', '')
			.split(/[/.]/)
			.filter((_, __, array) => input.includes('micorsoft') ? array.reverse() : array)
			.find((word: string) => iconFiles.includes(word.toLowerCase()) || iconFiles.includes(word))
			?.toLowerCase();

		const iconFile = app.vault.getAbstractFileByPath(`${iconDir}/${icon}.png`);
		return iconFile ? `![icon](${iconFile.path})` : '🔗';
	}

	isValidURL = (str: string): boolean => {
		try {
			new URL(str);
			return true;
		} catch {
			return false;
		}
	};

	insertIntoBrackets = (input: string, insertText: string) => {
		return input?.replace('()', `(${insertText})`);
	};

	insertImageIntoMarkdownLinks = (input: string, imageMarkdown: string) => {
		return input?.replace(/\[([^\]]+?)\]\((.*?)\)/g, (match, label, url) => {
			return `[${label} ${imageMarkdown}](${url})`;
		});
	};
}

class SettingTab extends PluginSettingTab {
	plugin: LinkWithIconPlugin;

	constructor(app: App, plugin: LinkWithIconPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Settings for Link with Icon'});

		new Setting(containerEl)
			.setName('Icon Directory')
			.setDesc('Location to icon files')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.iconDir.toString())
				.setValue(this.plugin.settings.iconDir.toString())
				.onChange(async (value) => {
					this.plugin.settings.iconDir = value;
					await this.plugin.saveSettings();
				}));
	}
}
