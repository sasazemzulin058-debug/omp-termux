# Матрица совместимости OMP в Termux (Android ARM64)

**Версия документа:** 1.0.0  
**Дата обновления:** 2026-08-11  
**Статус проекта:** Ограниченно совместим (`ОГРАНИЧЕННО СОВМЕСТИМ`) — сборка/установка автоматизированы, нативный аддон компилируется, но сквозная работа на физическом устройстве `НЕ ПРОВЕРЕНО` в полном объеме.

---

## 1. Область применения (Scope)

Документ определяет фактическое состояние, границы адаптации и ограничения при запуске инструмента автоматизации разработок `oh-my-pi` (OMP) в среде Termux на платформе Android ARM64 (`aarch64-linux-android`).

*   **Целевая архитектура:** ARM64 (`aarch64` / `arm64`).
*   **Среда выполнения:** Termux (Android API level 34+ / Android 14+ рекомендуется; Android API level 23+ минимально для libc/bionic pty).
*   **Движок выполнения:** Нативный Android Bun (`@oven/bun-linux-aarch64-android`, версия `1.3.14`).
*   **Ограничение ответственности:** Данный форк **не гарантирует 100% совместимость** со всеми подсистемами upstream-проекта.

---

## 2. Источники доказательств и точное состояние форка

### Ссылки на репозитории и ресурсы
*   **Официальный форк OMP Termux:** [sasazemzulin058-debug/omp-termux](https://github.com/sasazemzulin058-debug/omp-termux)
*   **Upstream OMP:** [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
*   **Скрипт установки:** [quickstart.sh](https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/quickstart.sh)
*   **Документация по адаптации:** [port-changes.md](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/android/docs/port-changes.md)
*   **Текущее состояние проекта:** [TERMUX_PROJECT_STATE.md](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/docs/TERMUX_PROJECT_STATE.md)
*   **Баг-трекер Bun (Android EACCES/seccomp):** [Oven-sh/bun#16238](https://github.com/Oven-sh/bun/issues/16238), [Oven-sh/bun#16452](https://github.com/Oven-sh/bun/issues/16452)
*   **Документация Termux по безопасности и ограничениям:** [Termux Wiki: Android 10 Restricted Access](https://wiki.termux.com/wiki/ANDROID_10)

### Фактическое состояние репозитория и CI
1.  **Последний успешный стабильный релиз:** `v0.1.6` (`НЕ ПРОВЕРЕНО` на физическом устройстве в полном объеме).
2.  **Тег `v17.2.12-termux`:** Создан в Git, но сборка в GitHub Actions [завершилась ошибкой (Run 31485948518)](https://github.com/sasazemzulin058-debug/omp-termux/actions/runs/31485948518) из-за превышения лимитов памяти/времени на runner (`SIGTERM` / exit 143 в Rust compiler). Релизные артефакты для этого тега **отсутствуют**.
3.  **Оверлей сборки:** Нативные патчи переведены из `android/patches/` в детерминированный Python-скрипт оверлея [`android/scripts/apply-overlay.py`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/android/scripts/apply-overlay.py) и верификатор [`android/scripts/verify-overlay.py`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/android/scripts/verify-overlay.py).
4.  **Установка:** Выполняется в один шаг через `quickstart.sh` без локальной сборки Rust/C++ на Android-устройстве.

---

## 3. Факты среды выполнения и целевая архитектура

1.  **Условия Rust cfg на Android:**
    *   При сборке под `aarch64-linux-android` компилятор выставляет: `target_family="unix"`, `target_os="android"`, `unix`.
    *   **Флаг `target_os = "linux"` НЕ выставляется.**
    *   *Следствие:* Любой upstream-код с условием `#[cfg(target_os = "linux")]` не компилируется или игнорируется на Android. Условия `#[cfg(not(target_os = "linux"))]` по умолчанию ошибочно включают код macOS/Windows (например, `arboard`).
2.  **Сборка нативности на CI:**
    *   Используется Android NDK r27 (`aarch64-linux-android-clang`).
    *   `cargo-zigbuild` **непригоден** для Android, так как Zig не поставляет заголовочные файлы и бинарники bionic C library (`libc not available`).
3.  **Системные вызовы bionic libc:**
    *   Поддержка `forkpty` и `openpty` присутствует начиная с API level 23.
    *   Вызовы `pidfd_open` и `pidfd_send_signal` работают только на Android 14+ (API level 34). На API 31–33 seccomp-фильтр Android может завершить процесс сигналом `SIGSYS`.

---

## 4. Подтвержденные риски и блокеры (Bun / Android Kernel)

1.  **Bun EACCES / Exec-permission (Android 10+ W^X restriction):**
    *   Android запрещает выполнение бинарных файлов из каталогов данных приложений (`/data/data/...`), если они не установлены в каталог приложения или специальный разрешенный путь.
    *   Установка OMP производится строго в `$PREFIX/lib/omp-termux/bun` и `$PREFIX/bin/omp`, где права на исполнение сохраняются.
2.  **Bun `cwd` / `getcwd()` fallback:**
    *   На некоторых прошивках Android при отсутствии доступа к рабочей директории или при её удалении Bun завершается с ошибкой.
3.  **Seccomp filters в Android:**
    *   Ядро Android ограничивает ряды системных вызовов (`epoll_create1`, `memfd_create`, `userfaultfd`, `pidfd_*`). Использование несогласованных системных вызовов приводит к немедленному сигналу `SIGSYS`.
4.  **Ограничения фоновых процессов (Phantom Process Killer):**
    *   Android 12+ принудительно завершает дочерние процессы Termux, если их количество превышает 32 или если они потребляют чрезмерные ресурсы CPU в фоне.

---

## 5. Матрица адаптации по подсистемам

| Подсистема | Статус | Форк-адаптация / Решение | Ограничения / Неразрешенные проблемы | Ссылка на исходник |
| :--- | :--- | :--- | :--- | :--- |
| **Runtime (Bun)** | `АДАПТИРОВАНО` | Загрузка нативного бинарника `@oven/bun-linux-aarch64-android` (v1.3.14). Исключена зависимость от glibc. | Возможны падения Bun на специфичных ядрах Android из-за seccomp (`НЕ ПРОВЕРЕНО`). | [`quickstart.sh`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/quickstart.sh) |
| **Native Addon (`pi_natives`)** | `АДАПТИРОВАНО` | Перекрестная сборка `pi_natives.android-arm64.node` с Android NDK r27. Зарегистрирован платформенный тег `android-arm64`. | Нет поддержки `arboard`. Удален `alloc_error_hook`. | [`loader-state.js`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/packages/natives/native/loader-state.js), [`apply-overlay.py`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/android/scripts/apply-overlay.py) |
| **Paths & Filesystem** | `АДАПТИРОВАНО` | Использование префикса Termux `$PREFIX` (`/data/data/com.termux/files/usr`). | Нельзя использовать жестко прописанные пути `/usr/bin`, `/tmp` или `/var/tmp`. | [`quickstart.sh`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/quickstart.sh) |
| **Shell & Execution** | `ОГРАНИЧЕННО` | Вызовы оболочки производятся через `/data/data/com.termux/files/usr/bin/sh` или `bash`. | Отсутствуют стандарты Linux FHS (`/bin/bash`). Исполняемые файлы вне `$PREFIX` недоступны. | [`port-changes.md`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/android/docs/port-changes.md) |
| **Process Management** | `АДАПТИРОВАНО` | Расширено условие `#[cfg(any(target_os = "linux", target_os = "android"))]` в `pi-shell` и `proc_snapshot`. | `pidfd_*` требуют Android 14+ (API 34). На старых версиях возможен `SIGSYS` (`НЕ ПРОВЕРЕНО`). | [`apply-overlay.py:56-64`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/android/scripts/apply-overlay.py) |
| **PTY (Pseudo-Terminal)** | `ПОДДЕРЖИВАЕТСЯ` | Вызовы `openpty`/`forkpty` из bionic libc нативно работают на Android 6.0+ (API 23+). | Требуются корректные права на `/dev/pts`. | [`port-changes.md`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/android/docs/port-changes.md) |
| **LSP (Language Servers)** | `НЕ ПРОВЕРЕНО` | Управление серверами LSP работает через фоновые процессы. | Серверы должны быть скомпилированы под Android/Termux и установлены в `$PREFIX/bin`. | Upstream OMP |
| **DAP (Debugger Protocol)** | `НЕ ПРОВЕРЕНО` | Взаимодействие по протоколу DAP аналогично LSP. | Зависит от наличия отладчиков (например, `lldb`, `gdb`, `debugpy`), адаптированных под Termux. | Upstream OMP |
| **Browser (Headless / Puppeteer)** | `НЕ ПОДДЕРЖИВАЕТСЯ` | Браузерные автоматизации и headless Chrome отсутствуют в нативной сборке. | Запуск Chrome/Chromium внутри Termux не поддерживается без X11/proot среды. | `ОГРАНИЧЕНИЕ ФОРКА` |
| **Clipboard** | `АДАПТИРОВАНО` | Отключена библиотека `arboard`. Вызовы `read_image_from_clipboard` возвращают `Ok(None)`, записи в буфер отключаются нативно. | Для текста рекомендуется интеграция с `termux-clipboard-set` на уровне JS. | [`apply-overlay.py:38-54`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/android/scripts/apply-overlay.py) |
| **Audio** | `НЕ ПОДДЕРЖИВАЕТСЯ` | Нативная звуковая подсистема Linux (ALSA/PulseAudio) отсутствует. | Для воспроизведения требуется `termux-media-player` (`НЕ ПРОВЕРЕНО`). | `ОГРАНИЧЕНИЕ ФОРКА` |
| **WebRTC** | `НЕ ПОДДЕРЖИВАЕТСЯ` | Нативные модули WebRTC не собираются под Android NDK в данном форке. | Отсутствует нативный интерфейс передачи потоков. | `ОГРАНИЧЕНИЕ ФОРКА` |
| **Isolation / Sandboxing** | `ОГРАНИЧЕННО` | Изоляция ограничена Linux UID/GID приложения Termux в Android. | Отсутствуют `namespaces`, `chroot` без root и полноценный `docker`/`podman`. | Android OS Security Model |
| **Install & Update** | `АДАПТИРОВАНО` | Автоматическая загрузка готовкой сборки JS + NDK-нативного аддона через `quickstart.sh`. | Нет автоматического фонового обновления; обновление переустановкой. | [`quickstart.sh`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/quickstart.sh) |
| **CI / Cross-Compile** | `АДАПТИРОВАНО` | Двухэтапный сборщик GitHub Actions (`android-release.yml`) с ограничениями ресурсов Rust. | GitHub Runners поддаются `SIGTERM` при компиляции больших Rust-крайтов без `CARGO_BUILD_JOBS=1`. | [`.github/workflows/android-release.yml`](https://github.com/sasazemzulin058-debug/omp-termux/blob/main/.github/workflows/android-release.yml) |
| **Security & Permissions** | `ПОДДЕРЖИВАЕТСЯ` | Соблюдение модели разрешений Android SELinux и Termux storage access. | Требуется явное разрешение `termux-setup-storage` для доступа к `/sdcard`. | Termux Wiki |
| **Lifecycle & Background** | `ОГРАНИЧЕННО` | Выполнение процессов в рамках сессии Termux. | Завершение процессов операционной системой из-за Phantom Process Killer в Android 12+. | Android OS restrictions |

---

## 6. Что форк уже решает (Solved Adaptations)

1.  **Полный сборщик оверлея (`apply-overlay.py`):**
    *   Удалена зависимость от `arboard` в `Cargo.toml` при `cfg(target_os = "android")`.
    *   Отключен ночной атрибут `#![feature(alloc_error_hook)]` и удалены вызовы `set_alloc_error_hook`, что позволяет собирать `pi-natives` на стабильном компиляторе Rust 1.95.0.
    *   Безопасные заглушки для работы с буфером обмена (возвращают `Ok(None)` вместо падения).
    *   Включены платформенные модули процессов (`pi-shell`, `proc_snapshot`, `ps_total_memory_bytes`) для `target_os = "android"`.
    *   В `loader-state.js` добавлена поддержка 플랫폼ного идентификатора `android-arm64`.
2.  **Сборка релиза в CI без сбоев памяти:**
    *   Workflow `android-release.yml` настраивает NDK r27 и передает флоги оптимизации для предотвращения завершения процесса по `SIGTERM` (exit 143).
3.  **Быстрая установка без компиляции на устройстве:**
    *   Скрипт `quickstart.sh` поставляет готовые артефакты, исключая необходимость наличия `clang`, `rustc` или `make` на целевом смартфоне.

---

## 7. Что форк намеренно НЕ решает (Non-Goals)

1.  **Поддержка буфера обмена через X11/Wayland/AppKit:**
    *   Форк не внедряет нативную интеграцию с графическими серверами Linux/macOS. Работа с текстом буфера обмена должна передаваться в утилиты `termux-api`.
2.  **Сборка под 32-битные архитектуры (ARMv7, x86):**
    *   Поддерживается только 64-битная архитектура `aarch64`.
3.  **Поддержка окружений glibc через proot/chroot:**
    *   Форк ориентирован строго на нативный bionic C library в Termux.
4.  **Управление графическим интерфейсом и Headless Chrome:**
    *   Интеграция с автоматизацией браузеров исключена из объема порта.

---

## 8. GitHub Actions Release Contract

Автоматизация публикаций релиза регулируется двумя workflow:

### 1. `sync-upstream.yml`
*   **Триггер:** Каждые 6 часов или вручную (`workflow_dispatch`).
*   **Действия:**
    1.  Импортирует дерево исходного кода из `can1357/oh-my-pi`.
    2.  Сохраняет файлы форка: `.github/`, `android/`, `quickstart.sh`, `install.sh`.
    3.  Запускает `python3 android/scripts/apply-overlay.py`.
    4.  Выполняет проверку через `python3 android/scripts/verify-overlay.py`.
    5.  При наличии изменений создает атомарный коммит и пушит тег `v${version}-termux`.

### 2. `android-release.yml`
*   **Триггер:** Пуш тега `v*-termux`.
*   **Схема сборки:**
    ```text
    native-addon (NDK r27) ──┐
                             ├─► package-release ──► GitHub Release
    js-bundle (Bun) ─────────┘
    ```
*   **Требования к артефактам:**
    *   `omp-termux.tar.gz`
    *   `omp-termux.tar.gz.sha256`
    *   `pi_natives.android-arm64.node`
    *   `pi_natives.android-arm64.node.sha256`

---

## 9. Программа приемочных испытаний (Acceptance Tests)

Тестирование на целевом устройстве Android ARM64 в Termux:

### Тест 1: Установка и проверку версии
```sh
# Команда установки
curl -fsSL https://raw.githubusercontent.com/sasazemzulin058-debug/omp-termux/main/quickstart.sh | sh

# Ожидаемый результат
omp --version
# Должен выводить версию (например, 0.1.6 или актуальную версию upstream)
```

### Тест 2: Загрузка нативного аддона
```sh
# Проверка отсутствия ошибок ELF / loader
omp --eval 'console.log("Bun and natives loaded successfully")'

# Ожидаемый результат: Вывод строки без ошибок dlopen или отсутствующих символов bionic.
```

### Тест 3: Проверка снимков процессов и системных вызовов
```sh
# Проверка функций управления процессами
omp --eval 'import { ps } from "pi-builtins"; console.log(ps)'

# Ожидаемый результат: Отсутствие завершения процесса по сигналу SIGSYS.
```

---

## 10. Приоритетная дорожная карта (Roadmap)

1.  **Высокий приоритет (P0):**
    *   Опубликовать успешный релиз под новым тегом upstream и подтвердить создание артефактов в `android-release.yml`.
    *   Провести физическое сквозное тестирование (E2E) на реальном Android-устройстве под управлением Android 14+ (`НЕ ПРОВЕРЕНО`).
2.  **Средний приоритет (P1):**
    *   Добавить интеграцию с `termux-clipboard-set` / `termux-clipboard-get` на уровне JS CLI для восстановления работы буфера обмена.
    *   Добавить обработку грациозного завершения при получении сигнала от Android Phantom Process Killer.
3.  **Низкий приоритет (P2):**
    *   Оптимизировать время сборки нативного аддона в GitHub Actions runner.

---

## 11. Текущий вердикт (Current Verdict)

**Вердикт:** `ОГРАНИЧЕННО СОВМЕСТИМ` (Partially Compatible)

Платформа OMP успешно адаптирована на уровне исходного кода Rust/JS и процессов CI для системы Android ARM64 (Termux). Автоматизация сборки нативного аддона с помощью NDK r27 и подготовка инсталлятора `quickstart.sh` функционируют. Однако полный цикл работы CLI OMP и проверка стабильности подсинтаксических вызовов Bun/seccomp на физических смартфонах имеют статус **`НЕ ПРОВЕРЕНО`**. До успешной публикации физических артефактов нового тега полной совместимости не заявляется.
