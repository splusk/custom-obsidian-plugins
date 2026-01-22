# Confluence Sync for Obsidian

Sync your Obsidian notes to Confluence with ease, preserving your folder structure and formatting.

## Features

- Upload current Obsidian file to Confluence
- **Automatically mirrors your vault folder structure** as parent-child page hierarchy in Confluence
- Converts Markdown to Confluence storage format with rich formatting support
- Updates existing pages or creates new ones
- Secure API token authentication

## Settings

Configure the following settings in Obsidian Settings > Confluence Sync:

- **Confluence Domain**: Your Confluence domain (e.g., `https://yourcompany.atlassian.net`)
- **Username**: Your Confluence username (email address)
- **API Token**: Your Confluence API token (see below for how to generate)
- **Space ID**: The Confluence space key where pages will be created

## Getting Your API Token

1. Go to [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click "Create API token"
3. Give it a label (e.g., "Obsidian Sync")
4. Copy the token and paste it into the plugin settings

## Usage

1. Open the file you want to sync to Confluence
2. Open the command palette (Cmd/Ctrl + P)
3. Search for "Sync current file to Confluence"
4. Press Enter

The plugin will:
- Use the filename as the Confluence page title
- **Recreate your vault's folder structure** in Confluence as parent-child pages
  - Example: `Tech/RnD/My Notes.md` becomes a page hierarchy: Space > Tech > RnD > My Notes
- Convert your Markdown content to Confluence storage format
- Create new pages or update existing pages with the same title and hierarchy

## Folder Structure Mapping

The plugin automatically creates a page hierarchy in Confluence that mirrors your Obsidian vault structure:

- Folders become parent pages in Confluence
- Files become child pages under their folder's page
- The entire path is preserved: `Folder1/Folder2/File.md` → `Folder1` > `Folder2` > `File`

## Supported Markdown Features

- **Headings** (# through ######)
- **Text formatting**: Bold, italic, bold+italic, strikethrough
- **Links** and URLs
- **Lists**: Bullet lists, numbered lists
- **Task lists**: `- [ ]` and `- [x]`
- **Code**: Inline code and fenced code blocks with syntax highlighting
- **Images**: Inline images
- **Tables**: Full markdown table support
- **Blockquotes**
- **Horizontal rules** (---)

## Development

### Build the plugin

```bash
npm install
npm run build
```

### Dev mode

```bash
npm run dev
```

## Installation

1. Download the latest release
2. Extract the files to your Obsidian vault's `.obsidian/plugins/confluence-sync/` folder
3. Reload Obsidian
4. Enable the plugin in Settings > Community plugins

## License

MIT
