[To Japanese Version README](README.ja.md)

[![Version](https://img.shields.io/badge/version-v0.1.6-4094ff.svg)](https://marketplace.visualstudio.com/items?itemName=komiyamma.commit-message-gene-by-gemini-cli)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)
![Windows 10|11](https://img.shields.io/badge/Windows-_10_|_11-6479ff.svg?logo=windows&logoColor=white)


# Commit Message Generator (by Gemini CLI)

This extension is a lightweight VS Code extension that calls the local Gemini CLI via a small Windows helper (gemini_proxy.exe) and generates Conventional Commits-style commit messages for the current repository. It is useful when GitHub Copilot is not available or when you want to use a different provider.

## Features

- Generate a Conventional Commits-style message with a single command
- Automatically write the generated result into Git's commit input box
	- "Commit message generation by gemini cli" (`commit-message-gene-by-gemini-cli.runGeminiCLICmd`)
	- You can search for it by typing "Commit message generation" in the Command Palette (Ctrl+Shift+P)

## Requirements

- After generation, the message is reflected as follows:
	- Inserted into the commit message input field in the Source Control view

- The helper looks for `%APPDATA%\npm\gemini.cmd` and executes it via `cmd.exe`.
- Make sure the gemini CLI is installed globally so that `gemini.cmd` exists at the above path.

gemini -p "《prompt》" -m "gemini-2.5-flash" -y

- The prompt instructs Gemini CLI to output only the final commit message in English and to wrap the entire text with specific marker lines.
	- Open the Source Control view once and try again.
	- Make sure the built-in Git extension is enabled.
	- Check the Output panel "gemini cli output" to see if there are any errors.

## How to use

1. Run the following command:
	- "Commit message generation by gemini cli" (`commit-message-gene-by-gemini-cli.runGeminiCLICmd`)
	- You can search for it by typing "Commit message generation" in the Command Palette (Ctrl+Shift+P)
2. While running, check the Output panel "gemini cli exec output".
3. When finished, the generated message is inserted into the commit message input field in Source Control.

## How it works

- The extension launches `gemini_proxy.exe` (bundled next to the compiled extension) with the `utf8` flag.
- The helper finds `%APPDATA%\npm\gemini.cmd` and runs the following command:

gemini -p "《prompt》" -m "gemini-2.5-flash" -y

- The prompt instructs Gemini CLI to output only the final commit message in English and to wrap the entire text with specific marker lines.
- The extension extracts the text between markers from standard output and writes it into the commit input box via the Git extension API (falling back to `scm.inputBox`).

## Privacy and data

- This extension itself does not upload code externally. However, depending on the settings, the local gemini cli CLI may send the repository context to the backend provider. Please review the privacy and data handling on the gemini cli side.

## Troubleshooting

- "gemini cli command not found": Check that `%APPDATA%\npm\gemini.cmd` exists and is executable. Reinstall/update the gemini CLI globally.
- Nothing appears in the commit field:
	- Open the Source Control view once and try again.
	- Make sure the built-in Git extension is enabled.
	- Check for errors in the Output panel "gemini cli exec output".


## Development

- Build: `npm run compile`
- Watch: `npm run watch`
- Lint: `npm run lint`
- The test scaffold uses `@vscode/test-electron`.

Main sources:

- `src/extension.ts` — VS Code activation and command registration
- `gemini_proxy/` — Windows helper that calls gemini cli

## License

MIT License © 2025 komiyamma
