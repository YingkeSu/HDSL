<div align="center">

# HDSL

**Your DSH starts here.**

A desktop launcher for managing DeepSeek Harness environments, versions, and plugins.

[简体中文](README.md) · **English**

[Download the preview](https://github.com/YingkeSu/HDSL/releases) · [User guide (Chinese)](docs/user-guide.md) · [Report an issue](https://github.com/YingkeSu/HDSL/issues)

</div>

---

![HDSL launch page with environment controls and available versions](docs/images/launcher.png)

<p align="center">One window to get started and manage your local DSH environments.</p>

## Let HDSL handle the setup

Want to try a new plugin without disturbing your everyday setup? Need separate environments for different projects? HDSL brings the preparation into a desktop window, so you can get started with DSH more easily.

- **Separate environments** — Create an environment for each kind of work, with its own settings and runtime data. Switch between them whenever you need.
- **Automatic setup** — Choose a supported version and let HDSL download and install the tools it needs.
- **Clear start and stop controls** — See status and progress, then open DSH in your browser once it is running.
- **Plugins when you need them** — Discover plugins, preview changes, and install or remove extensions. HDSL tells you when a restart is needed.
- **Try a new version, keep the previous setup** — Switch between supported DSH versions or restore a previous version and plugin combination.
- **Help when something goes wrong** — See errors and recovery status, and export diagnostics with sensitive information redacted.

![HDSL create-environment dialog with a name and runtime version selection](docs/images/create-environment.png)

*Actual macOS application screenshots, captured with a fresh temporary profile. The app currently uses a Chinese interface; the example name “日常工作” means “Everyday work.” An English README does not add an English app interface.*

## Download and install

Visit **[GitHub Releases](https://github.com/YingkeSu/HDSL/releases)**, expand **Assets** for the version you want, and download the archive for your computer. You do not need the source code.

| Your computer | Download | What is available |
| --- | --- | --- |
| Mac with Apple silicon (M series) | `HDSL-…-mac-arm64.zip` | The primary platform for the current preview |
| Windows on 64-bit Intel / AMD | `HDSL-…-win-x64-…-portable.zip` | Interface preview only; cannot create, install, or run DSH environments yet |
| Intel Mac, Windows ARM, Linux | None yet | Not currently supported |

**This is an early preview.** The Mac app is not Developer ID signed or notarized by Apple, and the Windows app is also unsigned. Your system may warn that it cannot verify the developer. Windows has not undergone hands-on acceptance testing. See each release's notes for its specific status.

On Mac, extract the archive and drag `HDSL.app` into Applications. On Windows, extract the entire folder and open `HDSL.exe`; keep its companion files alongside it.

## Your first environment

1. Open HDSL, create an environment, and give it a recognizable name.
2. Choose a supported version and wait for setup to finish. The first installation needs an internet connection.
3. Configure your API key using the [user guide (Chinese)](docs/user-guide.md). This currently requires macOS Keychain.
4. Start the environment, open DSH in your browser, and begin working.

You can then create another environment for a different project, or manage plugins and versions in an existing one.

## Before you try it

- Mac environments currently support DSH `0.1.5-rc.2` and `0.1.7-rc.1`. Other upstream versions shown in the list may not be available to install.
- Restoring an earlier version and plugin combination **does not undo changes to files or session data**. Back up important data separately.
- Environments use separate directories, but plugins may still access files outside them. Only install plugins you trust.
- Saved plugin settings may need a restart to take effect. HDSL cannot guarantee compatibility with every third-party plugin.
- Sharing environment packs is not available yet.

## Help and feedback

If something goes wrong, [open an issue](https://github.com/YingkeSu/HDSL/issues) with your operating system, the steps you followed, and the message you saw. Hide API keys and private information before attaching screenshots.

Want to contribute? Start with the [contribution guide](CONTRIBUTING.md) and [developer documentation](docs/README.md), currently in Chinese.

See [LICENSE](LICENSE) for use and distribution terms, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party components.
