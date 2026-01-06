# Claude Code Integration for Obsidian

An Obsidian plugin that allows you to query your vault contents using Claude Code.

## Features

- **Quick Access**: Open a modal with a keyboard shortcut
- **Vault Scanning**: Automatically scans all markdown files in your vault
- **Claude Code Integration**: Sends your notes and queries to Claude Code
- **Real-time Responses**: View Claude Code's responses directly in Obsidian

## Installation

### Development Installation

1. Clone this repository into your vault's plugins folder:
   ```bash
   cd /path/to/your/vault/.obsidian/plugins
   git clone https://github.com/yourusername/obsidian-claude-plugin claude-code-integration
   cd claude-code-integration
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the plugin:
   ```bash
   npm run build
   ```

4. Enable the plugin in Obsidian:
   - Open Settings → Community Plugins
   - Disable Safe Mode (if needed)
   - Enable "Claude Code Integration"

### Prerequisites

- Node.js installed on your system
- Claude Code CLI installed and accessible from your terminal
- Make sure `claude` command works in your terminal

## Usage

1. **Open the Query Modal**:
   - Use the command palette (Cmd/Ctrl + P)
   - Search for "Open Claude Code Query"
   - Or set up a keyboard shortcut in Settings → Hotkeys

2. **Enter Your Query**:
   - Type your question or prompt
   - Toggle "Include vault contents" if you want Claude to have context of all your notes
   - Press Cmd/Ctrl + Enter or click "Send to Claude Code"

3. **View Response**:
   - The response from Claude Code will appear in the output area
   - You can copy the response or close the modal when done

## Configuration

Go to Settings → Claude Code Integration to configure:

- **Vault Path**: Path to your Obsidian vault (default: `~/Documents/Obsidian/Kry`)
- **Claude Code Command**: Command to run Claude Code CLI (default: `claude`)

## Development

```bash
# Install dependencies
npm install

# Start development build (watches for changes)
npm run dev

# Production build
npm run build
```

## License

MIT
