[To English Version README](README.md)

[![Version](https://img.shields.io/badge/version-v0.1.7-4094ff.svg)](https://marketplace.visualstudio.com/items?itemName=komiyamma.commit-message-gene-by-gemini-cli)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)
![Windows 10|11](https://img.shields.io/badge/Windows-_10_|_11-6479ff.svg?logo=windows&logoColor=white)


# コミットメッセージジェネレーター (by Gemini CLI)

この拡張機能は、Windows の小さなヘルパー (gemini_proxy.exe) を介してローカルの Gemini CLI を呼び出し、現在のリポジトリ向けに Conventional Commits 形式のコミットメッセージを生成する軽量な VS Code 拡張機能です。GitHub Copilot が使えない環境や、別のプロバイダーを使いたい場合に便利です。

## 特長

- コマンド一発で Conventional Commits スタイルのメッセージを生成
- 生成結果を Git のコミット入力欄に自動で書き込み
  - 「Commit message generation by gemini cli」(`commit-message-gene-by-gemini-cli.runGeminiCLICmd`)
  - コマンドパレット (Ctrl+Shift+P) で「Commit message generation」と入力して検索できます

- ソース管理ビューに起動ボタンを追加
  - コミット入力欄のツールバー（menus.scm/inputBox）
  - 「ソース管理」タイトルバーのツールバー（menus.scm/title。表示幅が狭い場合は … の中）

- 実行中はウィンドウ下部のステータスバーにスピナーを表示

## 要件

- 生成後のメッセージは以下に反映されます:
  - ソース管理ビューのコミットメッセージ入力欄に挿入

- ヘルパーは `%APPDATA%\npm\gemini.cmd` を探し、`cmd.exe` 経由で実行します。
- `gemini.cmd` が上記パスに存在するよう、gemini CLI をグローバルにインストールしておいてください。

  gemini -p "《prompt》" -m "gemini-2.5-flash" -y

- プロンプトは Gemini CLI に対し、日本語の最終コミットメッセージのみを出力し、全文を特定のマーカー行で囲むよう要求します。
  - ソース管理ビューを一度開いてから再試行してください。
  - 組み込みの Git 拡張機能が有効か確認してください。
  - 出力パネルの「gemini cli output」を確認してエラーがないかチェックしてください。

## 使い方

1. 次のいずれかで実行:
  - 「Commit message generation by gemini cli」(`commit-message-gene-by-gemini-cli.runGeminiCLICmd`)
  - コマンドパレット (Ctrl+Shift+P) で「Commit message generation」と入力して検索
  - ソース管理ビューのツールバーのボタン（コミット入力欄／タイトルバー）をクリック（※幅が狭いと … 内）
2. 実行中は出力パネルの「gemini cli exec output」を確認します。
3. 完了すると、生成メッセージはソース管理のコミットメッセージ入力欄に挿入されます。

## 仕組み

- 拡張機能は `utf8` フラグ付きで `gemini_proxy.exe`（コンパイル済み拡張の隣に同梱）を起動します。
- ヘルパーは `%APPDATA%\npm\gemini.cmd` を見つけて、次のコマンドを実行します:

  gemini -p "《prompt》" -m "gemini-2.5-flash" -y

- プロンプトは Gemini CLI に対し、日本語の最終コミットメッセージのみを出力し、全文を特定のマーカー行で囲むよう要求します。
- 拡張機能は標準出力からマーカー間のテキストを抽出し、Git 拡張 API（フォールバックとして `scm.inputBox`）を通じてコミット入力欄に書き込みます。

## プライバシーとデータ

- この拡張機能自体はコードを外部にアップロードしません。ただし、ローカルの gemini cli CLI は設定に応じて、リポジトリの文脈をバックエンドプロバイダーに送信する場合があります。gemini cli 側のプライバシー・データ取り扱いをご確認ください。

## トラブルシューティング

- 「gemini cli command not found」: `%APPDATA%\npm\gemini.cmd` が存在し、実行可能であることを確認してください。gemini CLI をグローバル再インストール/更新してください。
- コミット欄に何も出ない:
  - ソース管理ビューを一度開いてから再試行してください。
  - 組み込みの Git 拡張機能が有効か確認してください。
  - 出力パネルの「gemini cli exec output」でエラーを確認してください。


## 開発

- Build: `npm run compile`
- Watch: `npm run watch`
- Lint: `npm run lint`
- テストのスキャフォールドは `@vscode/test-electron` を利用しています。

主要ソース:

- `src/extension.ts` — VS Code のアクティベーションとコマンド登録
- `gemini_proxy/` — gemini cli を呼び出す Windows ヘルパー

## ライセンス

MIT License © 2025 komiyamma
