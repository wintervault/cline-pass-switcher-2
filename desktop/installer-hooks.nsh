; NSIS 安装/卸载钩子（Tauri bundle.windows.nsis.installerHooks）
;
; 安全边界（防误删原则，见 CLAUDE.md 桌面壳章节）：
; - 本文件只做两件事：优雅关停请求 + 结束本应用自己的进程树。
; - 卸载器对文件的删除仅限其安装目录；%APPDATA%\com.wintervault.clinepass
;   （含密钥的 config 与日志）默认保留，本钩子与卸载器都不会删除它。

!macro NSIS_HOOK_PREINSTALL
  ; 升级安装前：先给运行中的服务一次优雅落盘机会，再结束壳进程树（避免文件占用）
  nsExec::Exec 'powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Method POST -Uri http://127.0.0.1:3123/api/shutdown -TimeoutSec 3 | Out-Null } catch {}"'
  Sleep 2000
  nsExec::Exec 'taskkill /F /T /IM cline-pass-switcher.exe'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载前：同上。Job Object 会在壳死亡时带走 node，这里先优雅是为了数据落盘
  nsExec::Exec 'powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Method POST -Uri http://127.0.0.1:3123/api/shutdown -TimeoutSec 3 | Out-Null } catch {}"'
  Sleep 2000
  nsExec::Exec 'taskkill /F /T /IM cline-pass-switcher.exe'
!macroend
