# Security Policy / Политика безопасности

## Supported versions / Поддерживаемые версии

Security fixes go into the latest release of GoatDrey AI (`craor/GoatDrey-AI`). Please update to the newest version from [Releases](https://github.com/craor/GoatDrey-AI/releases).

Исправления безопасности выходят в последней версии GoatDrey AI. Обновляйтесь из [Releases](https://github.com/craor/GoatDrey-AI/releases).

## Reporting a vulnerability / Как сообщить об уязвимости

**Please do not open a public GitHub issue** for a security vulnerability (especially anything that would let an attacker run code, steal API keys, or bypass the PC-control safety rules).

**Пожалуйста, не создавайте публичный Issue** об уязвимости (особенно если она позволяет выполнить код, украсть ключи API или обойти правила управления компьютером).

Report privately:

1. Use GitHub’s private reporting: [Security Advisories → Report a vulnerability](https://github.com/craor/GoatDrey-AI/security/advisories/new) on this repository.
2. If that is unavailable, open a **draft security advisory** or contact the maintainer through a private channel listed on the account.

Include, if you can:

- a short description of the issue and its impact;
- steps to reproduce, or a proof of concept (against your own machine);
- GoatDrey version, OS (Windows / macOS) and how the app was installed.

We will acknowledge the report, investigate, and publish a fix in a new release when we can. Please give us reasonable time before public disclosure.

Сообщите конфиденциально:

1. Через форму GitHub: [Security Advisories → Report a vulnerability](https://github.com/craor/GoatDrey-AI/security/advisories/new).
2. Если форма недоступна — черновик advisory или личное сообщение автору репозитория.

По возможности укажите:

- коротко, в чём проблема и чем она опасна;
- как воспроизвести (на своём компьютере);
- версию GoatDrey, систему (Windows / macOS) и способ установки.

Мы подтвердим получение, разберёмся и выпустим исправление в новой версии. Пожалуйста, дайте разумное время до публичного раскрытия.

## What is already in place / Что уже сделано

- Electron: `contextIsolation`, no `nodeIntegration`, renderer `sandbox`, strict CSP, no `webview`, navigation and `window.open` blocked (https links open in the system browser only), IPC sender checks, Electron Fuses (`RunAsNode` off, no `NODE_OPTIONS` / inspect, ASAR integrity, cookie encryption).
- API keys are stored only via Chromium `safeStorage` (OS encryption). They are never logged in full, never sent to the renderer unmasked, and are sent only to that provider’s own HTTPS host (localhost is allowed for Ollama / LM Studio).
- The agent’s safety rules (`src/main/safety.js`) are enforced in the main process and cannot be turned off from the UI. Tool, web and screen text is wrapped as untrusted data.
- Updates are accepted only from `craor/GoatDrey-AI` over HTTPS, with sha512 verification. **Authenticode / Apple Developer code signing is not included** (it needs a paid certificate); see the README for SignPath as a free option for Windows open-source builds.
