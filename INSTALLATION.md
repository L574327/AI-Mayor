# Installation Guide

This guide provides detailed instructions for installing all prerequisites required to run AI Mayor from source.

## Python Installation

### Windows
1. Visit [Python's official website](https://www.python.org/downloads/)
2. Download the latest Python installer
3. Run the installer and make sure to check "Add Python to PATH"
4. Verify installation in Command Prompt: `python --version`

Or using package managers:

```bash
# Using winget
winget install Python

# Using scoop
scoop install python
```

### macOS
```bash
# Using Homebrew
brew install python
```

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install python3
```

## Node.js Installation

### Windows
1. Visit [Node.js website](https://nodejs.org/)
2. Download and install the LTS version
3. Verify installation: `node --version` and `npm --version`

Or using package managers:

```bash
# Using winget
winget install OpenJS.NodeJS.LTS

# Using scoop
scoop install nodejs-lts
```

### macOS
```bash
# Using Homebrew
brew install node
```

### Linux (Ubuntu/Debian)
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install nodejs
```

## uv Package Manager Installation

Install uv using one of the following methods:

### Standalone Installers
```bash
# On macOS and Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# On Windows
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

### Via Python Package Managers
```bash
# With pip
pip install uv

# Or with pipx
pipx install uv
```

After installation, you can update uv to the latest version:
```bash
uv self update
```

Verify installation:
```bash
uv --version
```
