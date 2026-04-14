[To English Version README](README.md)

[![Version](https://img.shields.io/badge/version-v0.2.4-4094ff.svg)](https://marketplace.visualstudio.com/items?itemName=komiyamma.commit-message-gene-by-gemini-cli)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)


# コミットメッセージジェネレーター (by Gemini CLI)

リポジトリの変更から Conventional Commits 形式のコミットメッセージを自動生成して、ソース管理の入力欄へ挿入する VSCode 拡張です。  
`@google/gemini-cli-core` の Gemini CLI 認証を使うため、API key は不要です。  
GitHub Copilot が使えない環境でも手軽に使えます。


## 使い方

- ソース管理ビューのボタンから実行:
  - コミット入力欄のツールバー、または「ソース管理」タイトルバーのツールバー  
   [![Commit Input Box Button](images/button.png)](images/button.png)
  - 実行中はステータスバーにスピナーが表示されます  
    [![Commit StatusBar](images/statusbar.png)](images/statusbar.png)
- コマンドパレットから実行:
  - 「Commit message generation by gemini cli」
  - ID: `commit-message-gene-by-gemini-cli.runGeminiCLICmd`
  - 「Commit message generation」と入力して検索
- 完了すると、生成結果がコミットメッセージ入力欄に自動で入ります。

## 要件

- VS Code と Git が利用できること
- Gemini CLI のサインインが使えること、または Cloud Shell / GCE 系の環境で ADC が使えること
- Gemini CLI の認証状態は既定で `~/.gemini` に保存され、`GEMINI_CLI_HOME` が設定されている場合はその配下の `.gemini` を参照します
- VSCode の組み込み Git 拡張が有効であること
- 出力の確認は Output パネル「commit message gene」

## ライセンス

MIT License © 2025 komiyamma
