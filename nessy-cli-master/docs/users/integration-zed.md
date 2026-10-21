# Zed Editor

> Zed Editor provides native support for AI coding assistants through the Agent Client Protocol (ACP). This integration allows you to use Nessy CLI directly within Zed's interface with real-time code suggestions.

![Zed Editor Overview](https://img.alicdn.com/imgextra/i1/O1CN01aAhU311GwEoNh27FP_!!6000000000686-2-tps-3024-1898.png)

### Features

- **Native agent experience**: Integrated AI assistant panel within Zed's interface
- **Agent Client Protocol**: Full support for ACP enabling advanced IDE interactions
- **File management**: @-mention files to add them to the conversation context
- **Conversation history**: Access to past conversations within Zed

### Requirements

- Zed Editor (latest version recommended)
- Nessy CLI installed

### Installation

#### Install from ACP Registry (Recommend)

1. Install Nessy CLI:

```bash
npm install -g @nestor/nessy-cli
```

2. Download and install [Zed Editor](https://zed.dev/)

3. In Zed, click the **settings button** in the top right corner, select **"Add agent"**, choose **"Install from Registry"**, find **Nessy CLI**, then click **Install**.

   ![ACP Registry](https://img.alicdn.com/imgextra/i4/O1CN0186ybL61EeG35fHFjy_!!6000000000376-2-tps-3056-1705.png)

   ![Nessy CLI ACP Installed](https://img.alicdn.com/imgextra/i1/O1CN01OXHhoR1J8irAvjs8F_!!6000000000984-2-tps-1247-703.png)

#### Manual Install

1. Install Nessy CLI:

```bash
npm install -g @nestor/nessy-cli
```

2. Download and install [Zed Editor](https://zed.dev/)

3. In Zed, click the **settings button** in the top right corner, select **"Add agent"**, choose **"Create a custom agent"**, and add the following configuration:

```json
"nessy": {
  "type": "custom",
  "command": "nessy",
  "args": ["--acp"],
  "env": {}
}
```

![Nessy CLI Integration](https://img.alicdn.com/imgextra/i1/O1CN013s61L91dSE1J7MTgO_!!6000000003734-2-tps-2592-1234.png)

## Troubleshooting

### Agent not appearing

- Run `nessy --version` in terminal to verify installation
- Check that the JSON configuration is valid
- Restart Zed Editor

### Nessy CLI not responding

- Check your internet connection
- Verify CLI works by running `nessy` in terminal
- [File an issue on GitHub](https://github.com/nessylm/nessy/issues) if the problem persists
