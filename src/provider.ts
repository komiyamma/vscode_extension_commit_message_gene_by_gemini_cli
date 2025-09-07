export interface ProviderConfig {
  commandId: string;
  binaryName: string;
  messages: {
    runError: (msg: string, locale: 'ja' | 'en') => string;
    closed: (code: number | null, locale: 'ja' | 'en') => string;
  };
}

// Gemini CLI variant. In the other project, rename this file to provider.ts
// so that extension.ts can import `./provider` without referencing provider names.
export const provider: ProviderConfig = {
  commandId: 'commit-message-gene-by-gemini-cli.runGeminiCLICmd',
  binaryName: 'gemini_proxy.exe',
  messages: {
    runError: (msg, locale) =>
      locale === 'ja'
        ? `[gemini_proxy.exe 実行エラー]: ${msg}`
        : `[gemini_proxy.exe run error]: ${msg}`,
    closed: (code, locale) =>
      locale === 'ja'
        ? `\n[gemini_proxy.exe 終了: code ${code}]`
        : `\n[gemini_proxy.exe exited: code ${code}]`,
  },
};

